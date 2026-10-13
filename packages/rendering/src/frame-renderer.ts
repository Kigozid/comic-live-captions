import sharp from 'sharp';
import { captionMotionAtTime, renderCaptionLayerSvg } from './svg.js';
import { ExportValidationError, validateFrameExport } from './validation.js';
import type { ExportBubble, ExportCaption } from './validation.js';

export type Mp4Resolution = '720p' | '1080p' | 'custom';
export interface Mp4ExportOptions {
  readonly resolution: Mp4Resolution;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Shared video dimension resolution for browser captureStream export and
 * server-side FFmpeg export. Custom sizes are aligned to even values so the
 * H.264 yuv420p encoder accepts them.
 */
export function resolveMp4Dimensions(options: Mp4ExportOptions): {
  readonly width: number;
  readonly height: number;
} {
  if (options.resolution === '720p') return { width: 1280, height: 720 };
  if (options.resolution === '1080p') return { width: 1920, height: 1080 };
  const { width = 0, height = 0 } = options;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 7680 ||
    height > 7680
  )
    throw new RangeError(
      'Custom video dimensions must be whole numbers between 16 and 7680 pixels.',
    );
  return {
    width: Math.round(width / 2) * 2,
    height: Math.round(height / 2) * 2,
  };
}

export interface FrameRenderInput {
  readonly pageImage: Uint8Array;
  readonly captions: readonly ExportCaption[];
  readonly bubbles: readonly ExportBubble[];
  readonly time: number;
  readonly width: number;
  readonly height: number;
}

export interface FrameSequenceProgress {
  readonly frameIndex: number;
  readonly frameCount: number;
  readonly time: number;
}

export interface RenderedFrame {
  readonly index: number;
  readonly time: number;
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new RangeError('Render dimensions must be positive integers.');
}

/**
 * Letterboxed page geometry shared with the browser MP4 capture path: the page
 * is scaled to fit inside the frame and centered on black.
 */
function framePlacement(
  pageWidth: number,
  pageHeight: number,
  width: number,
  height: number,
): {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
} {
  const scale = Math.min(width / pageWidth, height / pageHeight);
  const fittedWidth = Math.max(1, Math.round(pageWidth * scale));
  const fittedHeight = Math.max(1, Math.round(pageHeight * scale));
  return {
    pageWidth: fittedWidth,
    pageHeight: fittedHeight,
    offsetX: Math.round((width - fittedWidth) / 2),
    offsetY: Math.round((height - fittedHeight) / 2),
  };
}

async function composeFrame(
  input: FrameRenderInput,
  time: number,
): Promise<Buffer> {
  assertDimensions(input.width, input.height);
  if (!Number.isFinite(time) || time < 0)
    throw new RangeError('Frame time must be finite and non-negative.');
  const metadata = await sharp(input.pageImage).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error('Comic image dimensions could not be read.');
  const placement = framePlacement(
    metadata.width,
    metadata.height,
    input.width,
    input.height,
  );
  const active = input.captions.filter(
    (caption) => caption.start! <= time && time < caption.end!,
  );
  // One SVG layer per active caption so each keeps its own fitted bubble
  // geometry and its own audio-paced entrance/exit. No bottom subtitle track.
  const captionLayers = await Promise.all(
    active.map(async (caption) => ({
      input: await sharp(
        Buffer.from(
          renderCaptionLayerSvg(
            metadata.width!,
            metadata.height!,
            [caption.layout!],
            captionMotionAtTime(caption.start!, caption.end!, time),
          ),
        ),
      )
        .png()
        .toBuffer(),
    })),
  );
  const pageLayer = await sharp(input.pageImage)
    .composite(captionLayers)
    .png()
    .toBuffer();
  const fittedPage = await sharp(pageLayer)
    .resize(placement.pageWidth, placement.pageHeight)
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: input.width,
      height: input.height,
      channels: 3,
      background: '#000000',
    },
  })
    .composite([
      {
        input: fittedPage,
        left: placement.offsetX,
        top: placement.offsetY,
      },
    ])
    .png()
    .toBuffer();
}

/**
 * Deterministic single-frame composition: page image plus every caption whose
 * audio interval contains `time`, drawn with the shared fitted caption layouts
 * inside their bubbles.
 */
export async function renderFrame(input: FrameRenderInput): Promise<Buffer> {
  const report = validateFrameExport(input.captions, input.bubbles);
  if (!report.valid) throw new ExportValidationError(report);
  return composeFrame(input, input.time);
}

/**
 * Iterates deterministic frames at `fps` for `durationSeconds`. The shared
 * caption validation runs once before the first frame.
 */
export async function* renderFrameSequence(
  input: Omit<FrameRenderInput, 'time'>,
  fps: number,
  durationSeconds: number,
  onProgress?: (progress: FrameSequenceProgress) => void,
): AsyncGenerator<RenderedFrame> {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240)
    throw new RangeError('Frame rate must be between 0 and 240 fps.');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new RangeError('Sequence duration must be finite and positive.');
  const report = validateFrameExport(input.captions, input.bubbles);
  if (!report.valid) throw new ExportValidationError(report);
  const frameCount = Math.max(1, Math.round(durationSeconds * fps));
  for (let index = 0; index < frameCount; index += 1) {
    const time = index / fps;
    const png = await composeFrame({ ...input, time }, time);
    onProgress?.({ frameIndex: index, frameCount, time });
    yield {
      index,
      time,
      png,
      width: input.width,
      height: input.height,
    };
  }
}
