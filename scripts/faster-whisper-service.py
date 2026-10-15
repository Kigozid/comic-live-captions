#!/usr/bin/env python3
"""Local faster-whisper transcription service (SYSTRAN/faster-whisper, MIT).

Typed HTTP protocol (localhost only):

  GET  /health
       -> {"status":"ok","provider":"faster-whisper","model":"small",
           "computeType":"int8","device":"cpu","ready":true}

  POST /transcribe
       Content-Type: application/json
       {
         "audio": "<base64 raw PCM s16le mono or encoded file bytes>",
         "sampleRateHz": 16000,          # required for raw PCM
         "encoding": "pcm-s16le" | "file",
         "language": "en",               # optional
         "wordTimestamps": true
       }
       -> {
            "ok": true,
            "text": "...",
            "language": "en",
            "languageProbability": 0.98,
            "durationSeconds": 12.34,
            "words": [
              {"text":"Hello","startSeconds":0.12,"endSeconds":0.48,"probability":0.97}
            ],
            "segments": [
              {"text":"Hello world","startSeconds":0.12,"endSeconds":1.2,
               "avgLogprob":-0.2,"compressionRatio":1.1,"noSpeechProb":0.01}
            ],
            "model": "small",
            "computeType": "int8"
          }
       -> {"ok":false,"error":"...","code":"EMPTY_AUDIO|MODEL_MISSING|..."}

Heavy weights load once at startup (or lazily). Inference is serialized with
a semaphore so 8 GB machines do not run two Whisper jobs at once. Models are
cached under HUGGINGFACE_HUB_CACHE / ~/.cache/huggingface — not re-downloaded
on every process start.

Setup (not part of ordinary `pnpm dev`):

  python3 -m pip install --user faster-whisper
  python3 scripts/faster-whisper-service.py --port 3041 --preload

Env:
  COMIC_WHISPER_MODEL       model size or HF id (default: small)
  COMIC_WHISPER_COMPUTE     compute type (default: int8)
  COMIC_WHISPER_DEVICE      cpu|cuda|auto (default: cpu)
  COMIC_WHISPER_LANGUAGE    optional default language
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

import numpy as np


DEFAULT_MODEL = os.environ.get("COMIC_WHISPER_MODEL", "small")
DEFAULT_COMPUTE = os.environ.get("COMIC_WHISPER_COMPUTE", "int8")
DEFAULT_DEVICE = os.environ.get("COMIC_WHISPER_DEVICE", "cpu")


class FasterWhisperEngine:
    def __init__(self, model_size: str, compute_type: str, device: str) -> None:
        self.model_size = model_size
        self.compute_type = compute_type
        self.device = device
        self.model = None
        self._lock = threading.Lock()
        self._infer_lock = threading.Semaphore(1)

    def load(self) -> None:
        with self._lock:
            if self.model is not None:
                return
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError(
                    "faster-whisper is not installed. Run: "
                    "python3 -m pip install --user faster-whisper"
                ) from exc
            # CPU + INT8 is the default for 8 GB Apple Silicon Macs.
            self.model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
            )

    def transcribe(
        self,
        samples: np.ndarray,
        sample_rate: int,
        language: Optional[str],
        word_timestamps: bool,
    ) -> dict[str, Any]:
        self.load()
        assert self.model is not None
        with self._infer_lock:
            segments_iter, info = self.model.transcribe(
                samples,
                sampling_rate=sample_rate,
                language=language,
                word_timestamps=word_timestamps,
                vad_filter=True,
                beam_size=5,
            )
            segments = []
            words = []
            for segment in segments_iter:
                segments.append(
                    {
                        "text": segment.text.strip(),
                        "startSeconds": float(segment.start),
                        "endSeconds": float(segment.end),
                        "avgLogprob": float(getattr(segment, "avg_logprob", 0.0)),
                        "compressionRatio": float(
                            getattr(segment, "compression_ratio", 1.0)
                        ),
                        "noSpeechProb": float(getattr(segment, "no_speech_prob", 0.0)),
                    }
                )
                for word in getattr(segment, "words", None) or []:
                    token = (word.word or "").strip()
                    if not token:
                        continue
                    words.append(
                        {
                            "text": token,
                            "startSeconds": float(word.start),
                            "endSeconds": float(word.end),
                            "probability": float(getattr(word, "probability", 0.0)),
                        }
                    )
            text = " ".join(s["text"] for s in segments).strip()
            return {
                "text": text,
                "language": getattr(info, "language", None),
                "languageProbability": float(
                    getattr(info, "language_probability", 0.0)
                ),
                "durationSeconds": float(getattr(info, "duration", 0.0)),
                "words": words,
                "segments": segments,
                "model": self.model_size,
                "computeType": self.compute_type,
            }


ENGINE = FasterWhisperEngine(DEFAULT_MODEL, DEFAULT_COMPUTE, DEFAULT_DEVICE)


def decode_audio(payload: dict[str, Any]) -> tuple[np.ndarray, int]:
    encoding = payload.get("encoding", "pcm-s16le")
    raw = base64.b64decode(payload["audio"])
    if encoding == "pcm-s16le":
        rate = int(payload.get("sampleRateHz") or 16000)
        if rate <= 0 or rate > 192000:
            raise ValueError("sampleRateHz must be a positive rate ≤ 192000")
        if len(raw) == 0:
            raise ValueError("EMPTY_AUDIO")
        if len(raw) % 2 != 0:
            raise ValueError("PCM s16le payload must have an even byte length")
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        return pcm, rate
    if encoding == "file":
        # Decode compressed audio with PyAV (bundled FFmpeg).
        try:
            import av
        except ImportError as exc:
            raise RuntimeError(
                "PyAV is required for encoded audio. Install faster-whisper "
                "which depends on av."
            ) from exc
        import io
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".bin", delete=True) as tmp:
            tmp.write(raw)
            tmp.flush()
            container = av.open(tmp.name)
            resampler = av.audio.resampler.AudioResampler(
                format="fltp", layout="mono", rate=16000
            )
            chunks: list[np.ndarray] = []
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    arr = converted.to_ndarray().flatten().astype(np.float32)
                    chunks.append(arr)
            for converted in resampler.resample(None):
                arr = converted.to_ndarray().flatten().astype(np.float32)
                chunks.append(arr)
            container.close()
        if not chunks:
            raise ValueError("EMPTY_AUDIO")
        return np.concatenate(chunks), 16000
    raise ValueError(f"unsupported encoding: {encoding}")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("faster-whisper: " + (fmt % args) + "\n")

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("", "/health", "/api/health"):
            self._send_json(
                200,
                {
                    "status": "ok",
                    "service": "faster-whisper",
                    "provider": "faster-whisper",
                    "model": ENGINE.model_size,
                    "computeType": ENGINE.compute_type,
                    "device": ENGINE.device,
                    "ready": ENGINE.model is not None,
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("/transcribe", "/api/transcribe"):
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 128 * 1024 * 1024:
                raise ValueError("invalid content-length")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            samples, rate = decode_audio(payload)
            language = payload.get("language")
            if language is not None and not isinstance(language, str):
                raise ValueError("language must be a string")
            word_timestamps = bool(payload.get("wordTimestamps", True))
            result = ENGINE.transcribe(
                samples,
                rate,
                language or os.environ.get("COMIC_WHISPER_LANGUAGE"),
                word_timestamps,
            )
            self._send_json(200, {"ok": True, **result})
        except ValueError as exc:
            code = str(exc) if str(exc) in ("EMPTY_AUDIO",) else "INVALID_REQUEST"
            self._send_json(400, {"ok": False, "error": str(exc), "code": code})
        except Exception as exc:  # noqa: BLE001 — boundary
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(exc), "code": "FAILED"})


def main() -> int:
    parser = argparse.ArgumentParser(description="Local faster-whisper service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3041)
    parser.add_argument("--preload", action="store_true")
    args = parser.parse_args()

    if args.preload:
        print(
            f"faster-whisper: loading {ENGINE.model_size} ({ENGINE.compute_type})…",
            flush=True,
        )
        ENGINE.load()
        print("faster-whisper: ready", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"faster-whisper: listening on http://{args.host}:{args.port} "
        f"(model={ENGINE.model_size}, compute={ENGINE.compute_type}, "
        f"device={ENGINE.device})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
