# faster-whisper transcription

Local ASR for Comic Captioner using
[SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT)
via CTranslate2. Audio inference runs in Python only; the Node API never
loads Whisper weights in the browser.

## Verified constraints (2026-10)

| Item | Value |
|------|--------|
| License | MIT |
| Python | 3.9+ (this Mac: 3.9.6) |
| macOS | CPU OK (INT8). No system FFmpeg required (PyAV bundles libs). |
| Default model | `small` + `compute_type=int8` (≈1.5 GB RAM for ~13 min audio) |
| Word timestamps | `word_timestamps=True` → per-word start/end/probability |
| Weights | Downloaded once from Hugging Face (`Systran/*` CT2); cached |

## Setup

```sh
python3 -m pip install --user faster-whisper
# optional: pre-download weights (not done on every API start)
pnpm whisper:fetch
# terminal 1 — model service
pnpm whisper:serve          # http://127.0.0.1:3041
# terminal 2 — app
export COMIC_ASR=faster-whisper
export COMIC_WHISPER_MODEL=small
export COMIC_WHISPER_URL=http://127.0.0.1:3041
pnpm dev
```

### Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `COMIC_ASR` | `faster-whisper` | `faster-whisper` \| `whisper` (transformers.js) \| `gemini` \| `offline` |
| `COMIC_WHISPER_MODEL` | `small` | Whisper size or HF CT2 id |
| `COMIC_WHISPER_COMPUTE` | `int8` | Service-side compute type |
| `COMIC_WHISPER_DEVICE` | `cpu` | Service-side device |
| `COMIC_WHISPER_URL` | `http://127.0.0.1:3041` | Local service base URL |
| `COMIC_WHISPER_LANGUAGE` | *(auto)* | Optional language hint |
| `GEMINI_API_KEY` | *(unset)* | Optional Gemini fallback (never hard-code) |

## Service protocol

`scripts/faster-whisper-service.py`:

- `GET /health` → `{status, model, computeType, device, ready}`
- `POST /transcribe` → words `[{text, startSeconds, endSeconds, probability}]`
  plus segments with `avgLogprob` / `noSpeechProb`

Model is **cached** (Hugging Face hub cache) and inference is **serialized**
(one job at a time) for 8 GB machines.

## Transcript schema (existing contract)

Provider output feeds `TranscriptionService` which validates and builds
`Transcript` / `TranscriptSegment` / `WordTimestamp` (times in **seconds**).
Overlapping words are clamped monotonic; pauses > 1.25 s or sentence ends
split segments.

### Example provider response (service)

```json
{
  "ok": true,
  "text": "Hello there friend",
  "language": "en",
  "languageProbability": 0.98,
  "durationSeconds": 3.2,
  "words": [
    { "text": "Hello", "startSeconds": 0.12, "endSeconds": 0.48, "probability": 0.97 },
    { "text": "there", "startSeconds": 0.52, "endSeconds": 0.78, "probability": 0.95 },
    { "text": "friend", "startSeconds": 0.84, "endSeconds": 1.21, "probability": 0.93 }
  ],
  "segments": [
    {
      "text": "Hello there friend",
      "startSeconds": 0.12,
      "endSeconds": 1.21,
      "avgLogprob": -0.18,
      "compressionRatio": 1.08,
      "noSpeechProb": 0.01
    }
  ],
  "model": "small",
  "computeType": "int8"
}
```

## Two stages (do not conflate)

1. **Audio-driven transcription** (`faster-whisper`) — spoken words + timings
   from the narration audio. This is `/api/transcribe`.
2. **Supplied-transcript alignment** — a **user-edited comic dialogue script**
   is aligned to the audio in a **separate** forced-alignment stage
   (WhisperX-style). In this repo that is `POST /api/align-words` /
   `refineWordTimesAcoustic` (wav2vec2 CTC Viterbi). Ordinary transcription
   does **not** rewrite an edited script.

## Tests

Unit tests use **mocked** sessions/fetch — no model download:

```sh
corepack pnpm test tests/unit/faster-whisper.test.ts tests/unit/transcription.test.ts
```

Covers: word mapping, empty/malformed output, overlapping times, missing
model, service down, env configuration, offline fallback.

## Failure modes

| Situation | Behavior |
|-----------|----------|
| Service down | `UNAVAILABLE` → Gemini fallback if allowed, else error |
| Weights missing | `MODEL_MISSING` with install hint |
| Empty audio | `EMPTY_AUDIO` (HTTP 400) |
| Unsupported media | decode error → `TRANSCRIBE_FAILED` |
| Timeout / cancel | `TranscriptionService` timeout / `ABORTED` |

## `POST /api/align-words` (forced alignment)

Aligns **supplied** segment text/words to audio with wav2vec2 CTC Viterbi
(`alignWordsAcoustic`). Separate from transcription — it does not invent
dialogue, it times an edited script. Times are **seconds** in `timebaseId`.

Request:

```json
{
  "pcm": "<base64 Float32LE mono>",
  "sampleRateHz": 16000,
  "timebaseId": "audio:align-words",
  "segments": [
    { "id": "seg-1", "text": "hello world", "start": 0, "end": 1.2, "speakerId": "spk_1" },
    { "id": "seg-2", "words": ["one", "two"], "start": 1.8, "end": 2.6 }
  ]
}
```

(`audio` base64 compressed file is an alternative to `pcm`.)

Response words:

```json
{
  "words": [
    {
      "id": "acoustic:seg-1:word-1",
      "text": "hello",
      "start": { "value": 0.12, "unit": "seconds", "timebase": "audio:align-words" },
      "end": { "value": 0.41, "unit": "seconds", "timebase": "audio:align-words" },
      "speakerId": "spk_1",
      "confidence": 0.81
    }
  ],
  "confidence": 0.81,
  "algorithm": "ctc-viterbi",
  "provider": "synthetic-ctc"
}
```

Errors: `INVALID_ALIGN_REQUEST` (400), `MODEL_MISSING` (503),
`FFMPEG_MISSING` (503), `ALIGNMENT_INVALID` (422).

Mocked tests inject `SyntheticCtcPosteriorsProvider` via
`createApiServer({ ctcProvider })` — no ONNX weights required.
