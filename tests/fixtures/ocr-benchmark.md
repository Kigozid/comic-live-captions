# OCR preprocessing benchmark

`ocr-benchmark.json` describes a deterministic five-case set: clear text,
half-resolution lettering, white lettering on a dark bubble, irregular display
lettering, and low-contrast text. The dark and low-contrast images are generated
from the checked-in synthetic `simple` fixture at run time; other inputs use
checked-in fixture PNGs and their ground-truth dialogue.

The benchmark runs actual `@paddleocr/paddleocr-js` PP-OCRv5 detection and
recognition inference on the Node WASM backend. It compares full-page input,
the fixture bubble bounding-box crop, and the fixture text-region bounding-box
crop, before and after the same conservative pixel preprocessing rules used by
the web retry path. Model initialization is shared and excluded from per-case
time. The results include exact normalized character error rate (CER), word
error rate (WER), empty results, preprocessing time, inference time, and total
per-case processing time. Crop timings include crop generation. Results are
written to stdout as JSON and are not mocked.

The test set is intentionally small and synthetic. Its scores establish
relative behavior on these known cases, not expected accuracy on arbitrary
comic scans. In particular, a text-region crop can be too tight to preserve
punctuation or useful surrounding context. Bubble crops are preferred in the
editor where available.

To run the benchmark, place the official detection and recognition `.tar`
archives in a local directory as `ocr-detection-model.tar` and
`ocr-recognition-model.tar`, then run:

```sh
OCR_MODEL_DIR=/path/to/model-archives node --import tsx scripts/benchmark-ocr.mjs
```

Model files are intentionally not committed. The runner performs genuine
inference with the installed provider and prints model runtime warnings to
stderr separately from its JSON result.
