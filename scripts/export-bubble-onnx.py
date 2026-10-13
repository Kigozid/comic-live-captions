#!/usr/bin/env python3
"""Export comic-speech-bubble-detector.pt to ONNX for the ML proposal port.

Requires: torch, ultralytics (and their onnx/onnxruntime/onnxslim deps).

Usage:
  python3 scripts/export-bubble-onnx.py

Writes models/bubble-yolo/comic-speech-bubble-detector.onnx (YOLOv8, 2 classes).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PT = ROOT / "models" / "bubble-yolo" / "comic-speech-bubble-detector.pt"


def main() -> int:
    if not PT.is_file():
        print(f"missing weights: {PT}", file=sys.stderr)
        return 1
    try:
        from ultralytics import YOLO
    except ImportError:
        print("ultralytics is required: python3 -m pip install ultralytics onnx", file=sys.stderr)
        return 1

    model = YOLO(str(PT))
    out = model.export(format="onnx", imgsz=1024, opset=12, simplify=True, dynamic=False, half=False, device="cpu")
    print(f"exported: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
