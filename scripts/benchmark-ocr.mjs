import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PaddleOCR } from '../apps/api/node_modules/@paddleocr/paddleocr-js/dist/index.mjs';
import {
  analyzeOCRPixels,
  preprocessOCRPixels,
  resizeOCRPixels,
} from '../packages/shared/src/ocr-preprocessing.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = process.env.OCR_MODEL_DIR;
if (!modelDir)
  throw new Error(
    'Set OCR_MODEL_DIR to a directory containing detection and recognition model tar archives.',
  );
const detectionModel = await readFile(
  path.join(modelDir, 'ocr-detection-model.tar'),
);
const recognitionModel = await readFile(
  path.join(modelDir, 'ocr-recognition-model.tar'),
);
const manifest = JSON.parse(
  await readFile(path.join(root, 'tests/fixtures/ocr-benchmark.json'), 'utf8'),
);

class ImageDataShim {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
class CanvasShim {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.pixels = new Uint8ClampedArray();
    this.context = {
      putImageData: (image) => {
        this.pixels = new Uint8ClampedArray(image.data);
      },
      getImageData: () =>
        new ImageDataShim(
          new Uint8ClampedArray(this.pixels),
          this.width,
          this.height,
        ),
      drawImage: (source) => {
        this.pixels = new Uint8ClampedArray(source.pixels ?? source.data ?? []);
      },
    };
  }
  getContext() {
    return this.context;
  }
  close() {}
}
globalThis.ImageData = ImageDataShim;
globalThis.HTMLCanvasElement = CanvasShim;
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.document = { createElement: () => new CanvasShim() };
globalThis.createImageBitmap = async (source) => source;
globalThis.location = { protocol: 'http:' };

const engine = await PaddleOCR.create({
  lang: 'en',
  ocrVersion: 'PP-OCRv5',
  textDetectionModelName: 'PP-OCRv5_mobile_det',
  textDetectionModelAsset: { url: 'http://local.test/detection' },
  textRecognitionModelName: 'PP-OCRv5_mobile_rec',
  textRecognitionModelAsset: { url: 'http://local.test/recognition' },
  worker: false,
  ortOptions: { backend: 'wasm', numThreads: 1, simd: true },
  fetch: async (url) =>
    new Response(
      String(url).includes('detection') ? detectionModel : recognitionModel,
    ),
});

const rows = [];
try {
  const warmup = await sharp(
    path.join(root, 'tests/fixtures/simple/original.png'),
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  await engine.predict(
    new ImageDataShim(
      new Uint8ClampedArray(warmup.data),
      warmup.info.width,
      warmup.info.height,
    ),
    {
      textDetLimitSideLen: 1600,
      textDetLimitType: 'max',
      textRecScoreThresh: 0.2,
    },
  );
  for (const testCase of manifest.cases) {
    const fixtureDir = path.join(root, 'tests/fixtures', testCase.fixture);
    const truth = JSON.parse(
      await readFile(path.join(fixtureDir, 'ground-truth.json'), 'utf8'),
    );
    let page = await sharp(path.join(fixtureDir, 'original.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (testCase.scale && testCase.scale !== 1) {
      const resized = await sharp(page.data, { raw: page.info })
        .resize(
          Math.round(page.info.width * testCase.scale),
          Math.round(page.info.height * testCase.scale),
        )
        .png()
        .toBuffer();
      page = await sharp(resized)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    }
    if (testCase.lowContrast) {
      for (let index = 0; index < page.data.length; index += 4) {
        const value = Math.max(0, Math.min(255, page.data[index] * 0.3 + 172));
        page.data[index] = page.data[index + 1] = page.data[index + 2] = value;
      }
    }
    if (testCase.darkBubble) {
      const svg = Buffer.from(
        `<svg width="${page.info.width}" height="${page.info.height}" xmlns="http://www.w3.org/2000/svg"><ellipse cx="320" cy="220" rx="185" ry="108" fill="#22252b"/><text x="320" y="236" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="700" fill="white">HELLO</text></svg>`,
      );
      page = await sharp(page.data, { raw: page.info })
        .composite([{ input: svg }])
        .png()
        .toBuffer()
        .then((buffer) =>
          sharp(buffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true }),
        );
    }
    const geometryScaleX = page.info.width / truth.dimensions.width;
    const geometryScaleY = page.info.height / truth.dimensions.height;
    const bubble = truth.expected.bubbles[0].boundingBox;
    const textRegion = truth.expected.textRegions[0].boundingBox;
    const pagePixels = {
      width: page.info.width,
      height: page.info.height,
      data: new Uint8ClampedArray(page.data),
    };
    const cropPixels = async (bounds, paddingFraction) => {
      const padX = bounds.width * paddingFraction;
      const padY = bounds.height * paddingFraction;
      const left = Math.max(0, Math.floor((bounds.x - padX) * geometryScaleX));
      const top = Math.max(0, Math.floor((bounds.y - padY) * geometryScaleY));
      const right = Math.min(
        page.info.width,
        Math.ceil((bounds.x + bounds.width + padX) * geometryScaleX),
      );
      const bottom = Math.min(
        page.info.height,
        Math.ceil((bounds.y + bounds.height + padY) * geometryScaleY),
      );
      const crop = await sharp(page.data, { raw: page.info })
        .extract({ left, top, width: right - left, height: bottom - top })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        width: crop.info.width,
        height: crop.info.height,
        data: new Uint8ClampedArray(crop.data),
      };
    };
    const originalVariants = [['page-original', pagePixels, 0]];
    let cropStarted = performance.now();
    originalVariants.push([
      'bubble-crop-original',
      await cropPixels(bubble, 0),
      performance.now() - cropStarted,
    ]);
    cropStarted = performance.now();
    originalVariants.push([
      'text-region-crop-original',
      await cropPixels(textRegion, 0),
      performance.now() - cropStarted,
    ]);
    const enhancedPageStarted = performance.now();
    const enhancedPageScale =
      Math.max(pagePixels.width, pagePixels.height) < 1150
        ? Math.min(2.5, 1150 / Math.max(pagePixels.width, pagePixels.height))
        : 1;
    const scaledPage =
      enhancedPageScale > 1
        ? await resizeOCRPixels(pagePixels, enhancedPageScale, 1800)
        : pagePixels;
    const pageEnhanced = await preprocessOCRPixels(scaledPage, {
      grayscale: true,
      contrast: 1.08,
      invert: 'auto',
      adaptiveThreshold: true,
    });
    const enhancedVariants = [
      [
        'page-enhanced',
        pageEnhanced.image,
        performance.now() - enhancedPageStarted,
      ],
    ];
    for (const [label, box] of [
      ['bubble-crop-enhanced', bubble],
      ['text-region-crop-enhanced', textRegion],
    ]) {
      const cropStartedAt = performance.now();
      const cropped = await cropPixels(
        box,
        label.startsWith('bubble') ? 0.04 : 0.24,
      );
      const cropScale = Math.min(
        3,
        1800 / Math.max(cropped.width, cropped.height),
        Math.max(1, 620 / Math.max(cropped.width, cropped.height)),
      );
      const scaled =
        cropScale > 1
          ? await resizeOCRPixels(cropped, cropScale, 1800)
          : cropped;
      const analysis = analyzeOCRPixels(scaled);
      const enhanced = await preprocessOCRPixels(scaled, {
        grayscale: true,
        contrast: analysis.luminanceRange < 70 ? 1.16 : 1.08,
        invert: 'auto',
        adaptiveThreshold: true,
      });
      enhancedVariants.push([
        label,
        enhanced.image,
        performance.now() - cropStartedAt,
      ]);
    }
    for (const [variant, pixels, preprocessingMs] of [
      ...originalVariants,
      ...enhancedVariants,
    ]) {
      const started = performance.now();
      const [result] = await engine.predict(
        new ImageDataShim(pixels.data, pixels.width, pixels.height),
        {
          textDetLimitSideLen: 1600,
          textDetLimitType: 'max',
          textRecScoreThresh: 0.2,
        },
      );
      const totalMs = performance.now() - started;
      const text =
        result?.items
          .map((item) => item.text)
          .join(' ')
          .trim() ?? '';
      rows.push({
        case: testCase.id,
        category: testCase.category,
        variant,
        expected: testCase.expectedText,
        actual: text,
        cer: cer(testCase.expectedText, text),
        wer: wer(testCase.expectedText, text),
        empty: text.length === 0,
        preprocessingMs,
        inferenceMs: result?.metrics.totalMs ?? totalMs,
        processingMs: preprocessingMs + totalMs,
      });
    }
  }
} finally {
  await engine.dispose();
}

const grouped = new Map();
for (const row of rows) {
  const samples = grouped.get(row.variant) ?? [];
  samples.push(row);
  grouped.set(row.variant, samples);
}
const summary = [...grouped.entries()].map(([variant, samples]) => ({
  variant,
  cases: samples.length,
  meanCER: average(samples.map((sample) => sample.cer)),
  meanWER: average(samples.map((sample) => sample.wer)),
  emptyResults: samples.filter((sample) => sample.empty).length,
  emptyFrequency:
    samples.filter((sample) => sample.empty).length / samples.length,
  meanPreprocessingMs: average(samples.map((sample) => sample.preprocessingMs)),
  meanInferenceMs: average(samples.map((sample) => sample.inferenceMs)),
  meanProcessingMs: average(samples.map((sample) => sample.processingMs)),
}));
console.log(
  JSON.stringify(
    {
      provider: manifest.provider,
      modelInitializationExcluded: true,
      cases: rows,
      summary,
    },
    null,
    2,
  ),
);

function normalize(text) {
  return text
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleUpperCase('en-US');
}
function cer(expected, actual) {
  const a = [...normalize(expected)];
  const b = [...normalize(actual)];
  return a.length ? editDistance(a, b) / a.length : b.length ? 1 : 0;
}
function wer(expected, actual) {
  const a = normalize(expected).split(' ').filter(Boolean);
  const b = normalize(actual).split(' ').filter(Boolean);
  return a.length ? editDistance(a, b) / a.length : b.length ? 1 : 0;
}
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + Number(a[i - 1] !== b[j - 1]),
      );
      diagonal = old;
    }
  }
  return row[b.length];
}
function average(values) {
  return (
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  );
}
