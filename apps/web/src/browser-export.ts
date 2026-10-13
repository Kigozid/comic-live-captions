import { renderCaptionLayerSvg } from '../../../packages/rendering/src/svg.js';
import { validateFrameExport } from '../../../packages/rendering/src/validation.js';
import type {
  ExportBubble,
  ExportCaption,
  ExportValidationReport,
} from '../../../packages/rendering/src/validation.js';

export async function exportComicFrame(
  source: Blob,
  captions: readonly ExportCaption[],
  bubbles: readonly ExportBubble[],
  time: number,
  format: 'png' | 'jpeg',
): Promise<{
  readonly blob: Blob | null;
  readonly report: ExportValidationReport;
}> {
  const report = validateFrameExport(captions, bubbles);
  if (!report.valid) return { blob: null, report };
  if (!Number.isFinite(time) || time < 0)
    throw new RangeError('Export time must be non-negative.');
  const sourceBitmap = await createImageBitmap(source);
  try {
    const activeLayouts = captions
      .filter((caption) => caption.start! <= time && time < caption.end!)
      .map((caption) => caption.layout!);
    const svg = renderCaptionLayerSvg(
      sourceBitmap.width,
      sourceBitmap.height,
      activeLayouts,
    );
    const overlay = await createImageBitmap(
      new Blob([svg], { type: 'image/svg+xml' }),
    );
    try {
      const canvas = document.createElement('canvas');
      canvas.width = sourceBitmap.width;
      canvas.height = sourceBitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create the export canvas.');
      context.drawImage(sourceBitmap, 0, 0);
      context.drawImage(overlay, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) =>
            result
              ? resolve(result)
              : reject(new Error('Image encoding failed.')),
          `image/${format}`,
          format === 'jpeg' ? 0.92 : undefined,
        );
      });
      return { blob, report };
    } finally {
      overlay.close();
    }
  } finally {
    sourceBitmap.close();
  }
}
