export interface OCRPixelImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface OCRPreprocessingOptions {
  readonly grayscale?: boolean;
  readonly contrast?: number;
  readonly invert?: 'never' | 'auto' | 'always';
  readonly adaptiveThreshold?: boolean;
  readonly denoise?: boolean;
}

export interface OCRImageAnalysis {
  readonly meanLuminance: number;
  readonly luminanceRange: number;
  readonly darkPixelFraction: number;
  readonly impulseNoiseFraction: number;
}

export interface OCRPreprocessingResult {
  readonly image: OCRPixelImage;
  readonly analysis: OCRImageAnalysis;
  readonly inverted: boolean;
  readonly thresholded: boolean;
  readonly denoised: boolean;
}

const ROWS_PER_CHUNK = 32;

/** Analyze visible pixels only; transparent crop padding does not skew polarity. */
export function analyzeOCRPixels(
  image: OCRPixelImage,
  inspectNoise = false,
): OCRImageAnalysis {
  assertRaster(image);
  let sum = 0;
  let squares = 0;
  let count = 0;
  let dark = 0;
  let impulse = 0;
  let sampled = 0;
  const luminances: number[] = [];
  // Bound synchronous analysis on very large pages. At most ~65k samples are
  // sorted; expensive neighborhood checks only run when denoising was asked for.
  const sampleStep = Math.max(
    2,
    Math.ceil(Math.max(image.width, image.height) / 256),
  );
  for (let y = 0; y < image.height; y += sampleStep) {
    for (let x = 0; x < image.width; x += sampleStep) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + 3]! < 96) continue;
      const lum = luminance(image.data, offset);
      luminances.push(lum);
      sum += lum;
      squares += lum * lum;
      count += 1;
      if (lum < 112) dark += 1;
      if (inspectNoise && isIsolatedExtreme(image, x, y, lum)) impulse += 1;
      sampled += 1;
    }
  }
  if (sampled === 0)
    return {
      meanLuminance: 255,
      luminanceRange: 0,
      darkPixelFraction: 0,
      impulseNoiseFraction: 0,
    };
  luminances.sort((a, b) => a - b);
  const low = luminances[Math.floor((luminances.length - 1) * 0.1)]!;
  const high = luminances[Math.floor((luminances.length - 1) * 0.9)]!;
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, squares / count - mean * mean));
  return {
    meanLuminance: mean,
    luminanceRange: Math.max(high - low, deviation * 1.5),
    darkPixelFraction: dark / count,
    impulseNoiseFraction: inspectNoise ? impulse / sampled : 0,
  };
}

/**
 * Conservative OCR enhancement. It creates new pixels, never mutates source
 * pixels, and keeps thresholding/denoising opt-in for comparison runs.
 */
export async function preprocessOCRPixels(
  source: OCRPixelImage,
  options: OCRPreprocessingOptions = {},
): Promise<OCRPreprocessingResult> {
  assertRaster(source);
  await yieldToBrowser();
  const analysis = analyzeOCRPixels(source, Boolean(options.denoise));
  const inverted =
    options.invert === 'always' ||
    (options.invert !== 'never' &&
      analysis.darkPixelFraction >= 0.62 &&
      analysis.meanLuminance < 118);
  const lowContrast = analysis.luminanceRange < 92;
  const shouldDenoise =
    Boolean(options.denoise) && analysis.impulseNoiseFraction >= 0.025;
  const output = new Uint8ClampedArray(source.data.length);
  const contrast = clamp(options.contrast ?? 1.1, 0.85, 1.35);
  const useGray = options.grayscale ?? true;

  for (let y = 0; y < source.height; y += ROWS_PER_CHUNK) {
    const lastY = Math.min(source.height, y + ROWS_PER_CHUNK);
    for (let row = y; row < lastY; row += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const offset = (row * source.width + x) * 4;
        const alpha = source.data[offset + 3]!;
        if (alpha < 96) {
          output[offset] = output[offset + 1] = output[offset + 2] = 255;
          output[offset + 3] = 255;
          continue;
        }
        let red = source.data[offset]!;
        let green = source.data[offset + 1]!;
        let blue = source.data[offset + 2]!;
        if (useGray) red = green = blue = luminance(source.data, offset);
        if (inverted) {
          red = 255 - red;
          green = 255 - green;
          blue = 255 - blue;
        }
        red = contrastChannel(red, contrast);
        green = contrastChannel(green, contrast);
        blue = contrastChannel(blue, contrast);
        output[offset] = red;
        output[offset + 1] = green;
        output[offset + 2] = blue;
        output[offset + 3] = 255;
      }
    }
    if (lastY < source.height) await yieldToBrowser();
  }

  const enhanced: OCRPixelImage = {
    width: source.width,
    height: source.height,
    data: output,
  };
  const thresholded = Boolean(options.adaptiveThreshold) && lowContrast;
  const denoised = shouldDenoise;
  let result = enhanced;
  if (thresholded) result = await blendAdaptiveThreshold(enhanced);
  if (denoised) result = await medianDenoise(result);
  return { image: result, analysis, inverted, thresholded, denoised };
}

/** Bilinear scaling avoids nearest-neighbor stair steps in thin comic lettering. */
export async function resizeOCRPixels(
  source: OCRPixelImage,
  scale: number,
  maximumSide = 1800,
): Promise<OCRPixelImage> {
  assertRaster(source);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error('OCR image scale must be positive and finite.');
  const cappedScale = Math.min(
    scale,
    maximumSide / Math.max(source.width, source.height),
  );
  const width = Math.max(1, Math.round(source.width * cappedScale));
  const height = Math.max(1, Math.round(source.height * cappedScale));
  if (width === source.width && height === source.height) return source;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += ROWS_PER_CHUNK) {
    const lastY = Math.min(height, y + ROWS_PER_CHUNK);
    for (let targetY = y; targetY < lastY; targetY += 1) {
      const sourceY = Math.max(0, (targetY + 0.5) / cappedScale - 0.5);
      const y0 = Math.min(source.height - 1, Math.floor(sourceY));
      const y1 = Math.min(source.height - 1, y0 + 1);
      const fy = sourceY - y0;
      for (let targetX = 0; targetX < width; targetX += 1) {
        const sourceX = Math.max(0, (targetX + 0.5) / cappedScale - 0.5);
        const x0 = Math.min(source.width - 1, Math.floor(sourceX));
        const x1 = Math.min(source.width - 1, x0 + 1);
        const fx = sourceX - x0;
        const targetOffset = (targetY * width + targetX) * 4;
        const offsets = [
          (y0 * source.width + x0) * 4,
          (y0 * source.width + x1) * 4,
          (y1 * source.width + x0) * 4,
          (y1 * source.width + x1) * 4,
        ];
        for (let channel = 0; channel < 4; channel += 1) {
          const top =
            source.data[offsets[0]! + channel]! * (1 - fx) +
            source.data[offsets[1]! + channel]! * fx;
          const bottom =
            source.data[offsets[2]! + channel]! * (1 - fx) +
            source.data[offsets[3]! + channel]! * fx;
          data[targetOffset + channel] = top * (1 - fy) + bottom * fy;
        }
      }
    }
    if (lastY < height) await yieldToBrowser();
  }
  return { width, height, data };
}

async function blendAdaptiveThreshold(
  image: OCRPixelImage,
): Promise<OCRPixelImage> {
  const width = image.width;
  const height = image.height;
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += luminance(image.data, (y * width + x) * 4);
      integral[(y + 1) * stride + x + 1] =
        integral[y * stride + x + 1]! + rowSum;
    }
    if ((y + 1) % ROWS_PER_CHUNK === 0) await yieldToBrowser();
  }
  const output = new Uint8ClampedArray(image.data.length);
  const radius = Math.max(
    5,
    Math.min(13, Math.floor(Math.min(width, height) / 36)),
  );
  for (let y = 0; y < height; y += ROWS_PER_CHUNK) {
    const lastY = Math.min(height, y + ROWS_PER_CHUNK);
    for (let row = y; row < lastY; row += 1) {
      const top = Math.max(0, row - radius);
      const bottom = Math.min(height - 1, row + radius);
      for (let x = 0; x < width; x += 1) {
        const left = Math.max(0, x - radius);
        const right = Math.min(width - 1, x + radius);
        const count = (right - left + 1) * (bottom - top + 1);
        const localMean =
          (integral[(bottom + 1) * stride + right + 1]! -
            integral[top * stride + right + 1]! -
            integral[(bottom + 1) * stride + left]! +
            integral[top * stride + left]!) /
          count;
        const offset = (row * width + x) * 4;
        const gray = image.data[offset]!;
        const binary = gray < localMean - 9 ? 0 : 255;
        // Keep 55% of the continuous grayscale signal to protect thin strokes.
        const value = gray * 0.55 + binary * 0.45;
        output[offset] = output[offset + 1] = output[offset + 2] = value;
        output[offset + 3] = image.data[offset + 3]!;
      }
    }
    if (lastY < height) await yieldToBrowser();
  }
  return { width, height, data: output };
}

async function medianDenoise(image: OCRPixelImage): Promise<OCRPixelImage> {
  const output = new Uint8ClampedArray(image.data);
  for (let y = 1; y < image.height - 1; y += ROWS_PER_CHUNK) {
    const lastY = Math.min(image.height - 1, y + ROWS_PER_CHUNK);
    for (let row = y; row < lastY; row += 1) {
      for (let x = 1; x < image.width - 1; x += 1) {
        const values: number[] = [];
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1)
            values.push(
              luminance(image.data, ((row + dy) * image.width + x + dx) * 4),
            );
        values.sort((a, b) => a - b);
        const offset = (row * image.width + x) * 4;
        const current = image.data[offset]!;
        const median = values[4]!;
        if (Math.abs(current - median) > 96)
          output[offset] = output[offset + 1] = output[offset + 2] = median;
      }
    }
    if (lastY < image.height - 1) await yieldToBrowser();
  }
  return { width: image.width, height: image.height, data: output };
}

function isIsolatedExtreme(
  image: OCRPixelImage,
  x: number,
  y: number,
  current: number,
): boolean {
  if (x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1)
    return false;
  let darker = 0;
  let lighter = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const neighbor = luminance(
        image.data,
        ((y + dy) * image.width + x + dx) * 4,
      );
      if (neighbor - current > 96) darker += 1;
      if (current - neighbor > 96) lighter += 1;
    }
  }
  return darker >= 6 || lighter >= 6;
}

function luminance(data: Uint8ClampedArray, offset: number): number {
  return (
    data[offset]! * 0.2126 +
    data[offset + 1]! * 0.7152 +
    data[offset + 2]! * 0.0722
  );
}

function contrastChannel(value: number, contrast: number): number {
  return clamp((value - 127.5) * contrast + 127.5, 0, 255);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function assertRaster(image: OCRPixelImage): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.length !== image.width * image.height * 4
  )
    throw new Error('OCR preprocessing requires valid RGBA image pixels.');
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
