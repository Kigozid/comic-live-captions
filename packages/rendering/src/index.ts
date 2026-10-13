import type { CaptionLayout } from '@comic-captioner/core';
import sharp from 'sharp';
import { renderCaptionLayerSvg, renderDebugLayerSvg } from './svg.js';
import type { RenderDebugOverlay } from './svg.js';
import {
  ExportValidationError,
  validateFrameExport,
} from './validation.js';
import type { ExportValidationReport, FrameExportInput } from './validation.js';

export {
  captionMotionAtTime,
  renderCaptionLayerSvg,
  renderDebugLayerSvg,
} from './svg.js';
export type { RenderDebugOverlay } from './svg.js';
export { ExportValidationError, validateFrameExport };
export type {
  ExportBubble,
  ExportCaption,
  ExportIssue,
  ExportIssueCode,
  ExportValidationReport,
  FrameExportInput,
} from './validation.js';
export {
  renderFrame,
  renderFrameSequence,
  resolveMp4Dimensions,
} from './frame-renderer.js';
export type {
  FrameRenderInput,
  FrameSequenceProgress,
  Mp4ExportOptions,
  Mp4Resolution,
  RenderedFrame,
} from './frame-renderer.js';

/** Export uses the same SVG caption primitive as browser preview. */
export class RenderingEngine {
  validate(
    input: Pick<
      FrameExportInput,
      'captions' | 'bubbles' | 'minimumReadability' | 'minimumConfidence'
    >,
  ): ExportValidationReport {
    return validateFrameExport(input.captions, input.bubbles, input);
  }

  async renderFrame(input: FrameExportInput): Promise<Buffer> {
    if (!Number.isFinite(input.time) || input.time < 0)
      throw new RangeError('Frame time must be finite and non-negative.');
    const report = this.validate(input);
    if (!report.valid) throw new ExportValidationError(report);
    const active = input.captions.filter(
      (caption) => caption.start! <= input.time && input.time < caption.end!,
    );
    const output = await this.renderPng(
      input.sourceImage,
      active.map((caption) => caption.layout!),
    );
    return input.format === 'jpeg'
      ? sharp(output)
          .jpeg({ quality: input.quality ?? 90 })
          .toBuffer()
      : output;
  }

  async renderPng(
    comicImage: Uint8Array,
    layouts: readonly CaptionLayout[],
    options: { readonly debugOverlays?: readonly RenderDebugOverlay[] } = {},
  ): Promise<Buffer> {
    const metadata = await sharp(comicImage).metadata();
    if (!metadata.width || !metadata.height)
      throw new Error('Comic image dimensions could not be read.');
    const composites: sharp.OverlayOptions[] = [
      {
        input: Buffer.from(
          renderCaptionLayerSvg(metadata.width, metadata.height, layouts),
        ),
      },
    ];
    if (options.debugOverlays?.length) {
      composites.push({
        input: Buffer.from(
          renderDebugLayerSvg(
            metadata.width,
            metadata.height,
            options.debugOverlays,
          ),
        ),
      });
    }
    return sharp(comicImage).composite(composites).png().toBuffer();
  }
}
