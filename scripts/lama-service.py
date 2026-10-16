#!/usr/bin/env python3
"""Local LaMa inpainting service for comic lettering removal.

Typed HTTP protocol (localhost only):

  GET  /health
       -> {"status":"ok","model":"big-lama","device":"mps|cpu","ready":true}

  POST /inpaint
       Content-Type: application/json
       {
         "image": "<base64 PNG or raw RGB/RGBA bytes encoded base64>",
         "mask":  "<base64 dense 0/1 or 0/255 mask, same size as image>",
         "width": int, "height": int,          # required for raw bytes
         "imageEncoding": "png" | "raw-rgb" | "raw-rgba",
         "maskEncoding": "raw" | "png"
       }
       -> {"ok":true,"image":"<base64 PNG>","width":W,"height":H}
       -> {"ok":false,"error":"..."}

Heavy weights load once at startup. Inference is sequential. The service is
optional: the Node API falls back to deterministic fill when it is absent.

Setup (not part of ordinary dev startup):

  python3 -m pip install --user simple-lama-inpainting
  python3 scripts/lama-service.py --port 3040

Model weights download on first start into the torch hub cache (or set
LAMA_MODEL to a local big-lama.pt path).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

import numpy as np
import torch
from PIL import Image


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class LamaEngine:
    def __init__(self) -> None:
        self.device = pick_device()
        self.model = None
        self.model_name = "big-lama"

    def load(self) -> None:
        if self.model is not None:
            return
        import torch

        if os.environ.get("LAMA_MODEL"):
            model_path = os.environ["LAMA_MODEL"]
            if not os.path.exists(model_path):
                raise FileNotFoundError(f"lama torchscript model not found: {model_path}")
        else:
            from simple_lama_inpainting.utils import download_model
            from simple_lama_inpainting.models.model import LAMA_MODEL_URL

            model_path = download_model(LAMA_MODEL_URL)

        # big-lama.pt is a CUDA TorchScript archive. map_location is required
        # or torch.jit.load tries to restore CUDA tensors and crashes on
        # CPU/MPS-only machines. Then move to the target device explicitly.
        self.model = torch.jit.load(model_path, map_location="cpu")
        self.model.eval()
        self.model.to(self.device)

    def inpaint(self, image: Image.Image, mask: Image.Image) -> Image.Image:
        self.load()
        assert self.model is not None
        from simple_lama_inpainting.utils import prepare_img_and_mask

        image_t, mask_t = prepare_img_and_mask(image, mask, self.device)
        with torch.inference_mode():
            inpainted = self.model(image_t, mask_t)
            cur_res = inpainted[0].permute(1, 2, 0).detach().cpu().numpy()
            cur_res = np.clip(cur_res * 255, 0, 255).astype(np.uint8)
            return Image.fromarray(cur_res)


ENGINE = LamaEngine()


def decode_image(payload: dict[str, Any]) -> Image.Image:
    encoding = payload.get("imageEncoding", "png")
    raw = base64.b64decode(payload["image"])
    if encoding == "png":
        from io import BytesIO

        return Image.open(BytesIO(raw)).convert("RGB")
    width = int(payload["width"])
    height = int(payload["height"])
    channels = 4 if encoding == "raw-rgba" else 3
    expected = width * height * channels
    if len(raw) != expected:
        raise ValueError(
            f"image byte length {len(raw)} != {width}x{height}x{channels}"
        )
    mode = "RGBA" if channels == 4 else "RGB"
    return Image.frombytes(mode, (width, height), raw).convert("RGB")


def decode_mask(payload: dict[str, Any], size: tuple[int, int]) -> Image.Image:
    encoding = payload.get("maskEncoding", "raw")
    raw = base64.b64decode(payload["mask"])
    if encoding == "png":
        from io import BytesIO

        mask = Image.open(BytesIO(raw)).convert("L")
        if mask.size != size:
            mask = mask.resize(size, Image.NEAREST)
        return mask
    width, height = size
    if len(raw) == width * height:
        array = np.frombuffer(raw, dtype=np.uint8).reshape(height, width)
    elif len(raw) == width * height * 4:
        array = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[
            :, :, 0
        ]
    else:
        raise ValueError(
            f"mask byte length {len(raw)} != {width}x{height}"
        )
    # Accept 0/1 or 0/255.
    return Image.fromarray((array > 0).astype(np.uint8) * 255, mode="L")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("lama-service: " + (fmt % args) + "\n")

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("", "/health", "/api/health"):
            ready = ENGINE.model is not None
            self._send_json(
                200,
                {
                    "status": "ok",
                    "service": "lama-inpaint",
                    "model": ENGINE.model_name,
                    "device": str(ENGINE.device),
                    "ready": ready,
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("/inpaint", "/api/inpaint"):
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 64 * 1024 * 1024:
                raise ValueError("invalid content-length")
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            image = decode_image(payload)
            mask = decode_mask(payload, image.size)
            result = ENGINE.inpaint(image, mask)
            from io import BytesIO

            buffer = BytesIO()
            result.save(buffer, format="PNG")
            self._send_json(
                200,
                {
                    "ok": True,
                    "image": base64.b64encode(buffer.getvalue()).decode("ascii"),
                    "width": result.size[0],
                    "height": result.size[1],
                },
            )
        except Exception as exc:  # noqa: BLE001 — boundary
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(exc)})


def main() -> int:
    parser = argparse.ArgumentParser(description="Local LaMa inpaint service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3040)
    parser.add_argument(
        "--preload",
        action="store_true",
        help="Load weights before accepting traffic",
    )
    args = parser.parse_args()

    # Prefer a local checkpoint when provided (avoids re-download).
    if os.environ.get("LAMA_MODEL") is None:
        candidate = os.path.join("models", "lama", "big-lama.pt")
        if os.path.exists(candidate):
            os.environ["LAMA_MODEL"] = os.path.abspath(candidate)

    if args.preload:
        print("lama-service: loading weights…", flush=True)
        ENGINE.load()
        print(f"lama-service: ready on {ENGINE.device}", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"lama-service: listening on http://{args.host}:{args.port} "
        f"(device={ENGINE.device}, model={ENGINE.model_name})",
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
