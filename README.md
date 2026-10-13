# Comic Captioner

Comic Captioner synchronizes dialogue to audio and places
captions inside the matching comic speech bubbles. This is not a conventional
subtitle application: captions belong in bubbles, never in a bottom-of-screen
subtitle track.

## Current status

The application includes image import/alignment, deterministic bubble and
text-region detection, OCR review, caption editing, audio timing, narration
preview, and export paths. OCR now runs in the browser with the official
`@paddleocr/paddleocr-js` SDK (English PP-OCRv5) and does not require Gemini.
Bubble geometry remains in the deterministic image-processing API.

Source images imported for geometry operations are kept in memory by the API
process. Saved project assets are stored locally in the browser.

## Local comic OCR

Import the original and cleaned pages, align them, then choose **Detect bubbles
+ OCR**. PaddleOCR initializes once per browser tab in a Web Worker; the first
scan downloads the official English detection and recognition models. Comic
pixels are passed to the worker locally for OCR. The same-origin API serves and
caches only the two allowlisted official model files to avoid cross-origin
model-download restrictions. OCR boxes and bubble outlines appear over the
page, and each detected line becomes editable source text and a caption draft.
No Gemini key is needed for this scan, review, correction, or manual caption
workflow.

## Workflow shortcuts

- **Auto-clean page** — erase bubble text from the original page so a
  hand-prepared cleaned page is optional. Import a cleaned page anytime to
  override.
- **Hybrid bubble detection** — ML (YOLO) or heuristic proposals boost recall;
  deterministic geometry always refines and scores the final contour.
- **Reading order** — LTR/RTL (manga) toggle; panel detection feeds bubble
  reading order used by content-based dialogue mapping.
- **OCR review queue** — only low-confidence words/lines are queued after each
  scan.
- **Auto everything** — one pass (detect → OCR → transcribe → map → fit →
  timeline) with a confidence-sorted review queue.
- **Keyboard review** — J/K navigate, A accept, E edit, Space play, 1–9 pick
  alternatives, ⌘Z/⌘⇧Z undo/redo.
- **Server MP4 export** — deterministic frame render + FFmpeg encode
  (`POST /api/export`). Falls back to browser captureStream when FFmpeg is
  missing. Probe with `GET /api/export/ffmpeg`.
- **ONNX models** — YOLOv10n bubble proposals + wav2vec2-base-960h CTC forced
  alignment. Fetch with `pnpm models:fetch`; status at `GET /api/models`.
  Env overrides: `COMIC_YOLO_MODEL`, `COMIC_WAV2VEC_MODEL`.
- **Acoustic word timing** — `POST /api/transcribe` refines Gemini word times
  with wav2vec2 CTC Viterbi forced alignment; `POST /api/align-words` exposes
  the same path for the editor (`refineWordTimesAcoustic`).

## Requirements

- Node.js 20.19 or newer
- pnpm 10.17.1 (`corepack pnpm install`)
- FFmpeg on PATH for server MP4 encode (`brew install ffmpeg` or a static build)
- Optional ONNX models for ML bubble proposals and wav2vec2 word timing:
  `corepack pnpm models:fetch` (downloads into `models/`, gitignored)

## Development

```sh
corepack pnpm install
corepack pnpm dev
```

The web app is served at `http://localhost:5173`; the API health endpoint is at
`http://localhost:3039/health`. Set `WEB_PORT` and `API_PORT` together when using
custom ports so the Vite API proxy and API server stay in sync.

Gemini Assist and audio transcription read `GEMINI_API_KEY` in the API process only.
For local development, copy `apps/api/.env.example` to `apps/api/.env` and set
the key there. The local `.env` is ignored by Git; never add credentials to the
web app or a checked-in file. Optional model names can be set in that same API
environment file.

## Checks

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm lint
corepack pnpm format:check
corepack pnpm build
```

Architecture and milestone documents live under `docs/`.
