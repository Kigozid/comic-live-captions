#!/usr/bin/env node
/**
 * Download ONNX weights for comic captioning:
 * - models/bubble-yolo/model.onnx       (YOLOv10n, 80-class detector fallback)
 * - models/wav2vec2/model_quantized.onnx (wav2vec2-base-960h CTC)
 *
 * The preferred bubble detector is comic-speech-bubble-detector.onnx,
 * exported from models/bubble-yolo/comic-speech-bubble-detector.pt via
 * `python3 scripts/export-bubble-onnx.py` (not downloaded).
 *
 * Models are gitignored. Re-run after a clean checkout.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const MODELS = [
  {
    url: 'https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx',
    path: join(root, 'models/bubble-yolo/model.onnx'),
    label: 'YOLOv10n (bubble proposals)',
  },
  {
    url: 'https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/onnx/model_quantized.onnx',
    path: join(root, 'models/wav2vec2/model_quantized.onnx'),
    label: 'wav2vec2-base-960h CTC (quantized)',
  },
];

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function fetchModel(model) {
  if (await exists(model.path)) {
    console.log(`skip  ${model.label} (already present)`);
    return;
  }
  console.log(`fetch ${model.label}`);
  console.log(`      ${model.url}`);
  await mkdir(dirname(model.path), { recursive: true });
  const response = await fetch(model.url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${model.label}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(model.path, buffer);
  console.log(`ok    ${model.label} → ${model.path} (${(buffer.length / 1024 / 1024).toFixed(1)} MiB)`);
}

let failed = 0;
for (const model of MODELS) {
  try {
    await fetchModel(model);
  } catch (error) {
    failed += 1;
    console.error(`fail  ${model.label}: ${error instanceof Error ? error.message : error}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
