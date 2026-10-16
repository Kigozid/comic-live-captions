#!/usr/bin/env node
/**
 * Validate lettering removal on one real comic page (not synthetic fixtures).
 *
 *   node --import tsx scripts/validate-real-page.mjs /path/to/page.png
 *
 * Writes output/lettering-validation/real-page/:
 *   original.png, cleaned.png, removal-mask.png, overlay.png,
 *   bubbles.png (detection preview), report.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const inputPath = process.argv[2] ?? '/Users/collins/Downloads/demo_lettered_page.png';
const outputDir = join(root, 'output/lettering-validation/real-page');

const { TextRegionDetector } = await import(
  join(root, 'packages/image-engine/src/text-regions.ts')
);
const { LetteringRemover } = await import(
  join(root, 'packages/image-engine/src/lettering-removal.ts')
);
const {
  BubbleDetectionEngine,
  HybridBubbleDetector,
  YoloBubbleProposalProvider,
} = await import(join(root, 'packages/bubble-engine/src/index.ts'));
const { createImageSpace } = await import(
  join(root, 'packages/shared/src/index.ts')
);
const { LamaHttpProvider } = await import(
  join(root, 'apps/api/src/lama-provider.ts')
);
const { detectTextRegionsForInpaint } = await import(
  join(root, 'packages/image-engine/src/inpaint.ts')
);

async function loadPng(path) {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

async function saveRaster(raster, path) {
  await sharp(
    Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength),
    { raw: { width: raster.width, height: raster.height, channels: 4 } },
  )
    .png()
    .toFile(path);
}

function countDarkPixels(raster) {
  let n = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (raster.data[i] < 70 && raster.data[i + 1] < 70 && raster.data[i + 2] < 70)
      n += 1;
  }
  return n;
}

function drawDetections(raster, bubbles, textRegions) {
  const out = new Uint8ClampedArray(raster.data);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
    const i = (y * raster.width + x) * 4;
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  };
  const strokeRect = (box, r, g, b) => {
    for (let x = Math.floor(box.x); x < box.x + box.width; x += 1) {
      set(x, Math.floor(box.y), r, g, b);
      set(x, Math.floor(box.y + box.height), r, g, b);
    }
    for (let y = Math.floor(box.y); y < box.y + box.height; y += 1) {
      set(Math.floor(box.x), y, r, g, b);
      set(Math.floor(box.x + box.width), y, r, g, b);
    }
  };
  for (const bubble of bubbles) {
    const xs = bubble.polygon.points.map((p) => p.x);
    const ys = bubble.polygon.points.map((p) => p.y);
    strokeRect(
      {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      },
      30,
      180,
      255,
    );
  }
  for (const region of textRegions) {
    strokeRect(region.boundingBox, 255, 60, 60);
  }
  return { width: raster.width, height: raster.height, data: out };
}

async function main() {
  if (!existsSync(inputPath)) {
    console.error('missing page:', inputPath);
    process.exit(1);
  }
  await mkdir(outputDir, { recursive: true });
  console.log('loading', inputPath);
  const original = await loadPng(inputPath);
  console.log(`page ${original.width}x${original.height}`);
  const space = createImageSpace(
    `image:real:${basename(inputPath)}`,
    original.width,
    original.height,
  );
  const pngBytes = new Uint8Array(await sharp(inputPath).png().toBuffer());

  // --- Bubbles (hybrid YOLO when weights exist, else deterministic) ---
  let bubbles = [];
  let bubbleMode = 'deterministic';
  try {
    const { loadYoloOnnxSession } = await import(
      join(root, 'apps/api/src/onnx-models.ts')
    );
    const session = await loadYoloOnnxSession();
    const detector = new HybridBubbleDetector({
      deterministic: new BubbleDetectionEngine(),
      provider: new YoloBubbleProposalProvider({
        session,
        ...(session.classLabels ? { classLabels: session.classLabels } : {}),
        confidenceThreshold: 0.25,
        bubbleClassesOnly: true,
        maximumProposals: 48,
      }),
    });
    const result = await detector.detect(pngBytes, space);
    bubbles = result.bubbles.map((entry) => ({
      id: entry.bubble.id,
      contour: entry.bubble.contour,
      polygon: entry.bubble.polygon,
      boundingBox: entry.bubble.boundingBox,
      interiorHint: 'white-balloon',
      confidence: entry.bubble.confidence,
      sources: entry.sources,
    }));
    bubbleMode = 'hybrid';
    console.log(`bubbles hybrid: ${bubbles.length}`);
  } catch (error) {
    console.warn('YOLO unavailable, deterministic bubbles:', error.message);
    const engine = new BubbleDetectionEngine();
    const result = await engine.detect(pngBytes, space);
    bubbles = result.bubbles.map((bubble) => ({
      id: bubble.id,
      contour: bubble.contour,
      polygon: bubble.polygon,
      boundingBox: bubble.boundingBox,
      interiorHint: 'white-balloon',
      confidence: bubble.confidence,
      sources: ['detected'],
    }));
    console.log(`bubbles deterministic: ${bubbles.length}`);
  }

  // --- Text regions ---
  const textDetector = new TextRegionDetector();
  const textResult = await textDetector.detect(pngBytes, space);
  const maxArea = original.width * original.height * 0.06;
  const minArea = 250;
  const detectedText = textResult.regions.filter((region) => {
    const area = region.boundingBox.width * region.boundingBox.height;
    // Keep compact lettering; drop dust and page-sized blobs.
    return (
      area >= minArea &&
      area <= maxArea &&
      region.confidence >= 0.7 &&
      region.boundingBox.width >= 12 &&
      region.boundingBox.height >= 8 &&
      region.boundingBox.width < original.width * 0.55 &&
      region.boundingBox.height < original.height * 0.25
    );
  });
  console.log(`text regions: ${detectedText.length} (from ${textResult.regions.length})`);

  // Ink masks inside bubbles (character-accurate lettering).
  const inkMasks = detectTextRegionsForInpaint(
    {
      width: original.width,
      height: original.height,
      data: original.data,
    },
    bubbles.map((b) => ({
      id: b.id,
      contour: {
        points: b.contour.points.map((p) => ({
          x: p.x,
          y: p.y,
          coordinateSpace: space,
        })),
        coordinateSpace: space,
      },
    })),
  );
  console.log(`ink masks in bubbles: ${inkMasks.length}`);

  const textRegions = [
    // Bubble-interior ink is the safe default (auto-erase under bubble-interior scope).
    ...inkMasks.map((ink) => ({
      id: `ink:${ink.id}`,
      mask: ink.pixels,
      boundingBox: ink.boundingBox,
      detectionConfidence: ink.confidence,
      associatedBubbleId: ink.bubbleId,
    })),
    // Full-page detections stay unreviewed and are held — never auto-erased.
    ...detectedText.map((region) => ({
      id: region.id,
      boundingBox: region.boundingBox,
      polygon: region.polygon,
      detectionConfidence: region.confidence,
      associatedBubbleId: null,
      reviewStatus: 'pending',
    })),
  ];

  // --- Lettering removal (LaMa when available) ---
  const lamaUrl = process.env.COMIC_LAMA_URL ?? 'http://127.0.0.1:3040';
  let generative = null;
  if (process.env.COMIC_LAMA_URL !== 'off') {
    generative = new LamaHttpProvider({ baseUrl: lamaUrl });
    if (!(await generative.available())) {
      console.warn('LaMa unavailable at', lamaUrl);
      generative = null;
    } else {
      console.log('LaMa ready at', lamaUrl);
    }
  }

  const remover = new LetteringRemover({ generative });
  const started = Date.now();
  const result = await remover.removeLettering({
    image: original,
    coordinateSpace: space,
    bubbles: bubbles.map((b) => ({
      id: b.id,
      contour: {
        points: b.contour.points.map((p) => ({
          x: p.x,
          y: p.y,
          coordinateSpace: space,
        })),
        coordinateSpace: space,
      },
      interiorHint: 'white-balloon',
    })),
    textRegions,
    options: {
      expansionPx: 3,
      preferLamaForArtwork: true,
      maximumGenerativeMaskPixels: 60_000,
      // Default safety policy: bubble-interior only; unreviewed free text held.
      erasureScope: 'bubble-interior',
    },
  });
  const elapsed = Date.now() - started;
  console.log(`cleaning took ${elapsed} ms, complete=${result.complete}`);

  await saveRaster(original, join(outputDir, 'original.png'));
  await saveRaster(result.cleaned, join(outputDir, 'cleaned.png'));
  await sharp(Buffer.from(result.removalMask), {
    raw: { width: result.width, height: result.height, channels: 1 },
  })
    .png()
    .toFile(join(outputDir, 'removal-mask.png'));

  // Overlay: cleaned + red mask
  {
    const overlay = new Uint8ClampedArray(result.cleaned.data);
    for (let i = 0; i < result.removalMask.length; i += 1) {
      if (!result.removalMask[i]) continue;
      overlay[i * 4] = 255;
      overlay[i * 4 + 1] = 40;
      overlay[i * 4 + 2] = 40;
      overlay[i * 4 + 3] = 255;
    }
    await saveRaster(
      { width: result.width, height: result.height, data: overlay },
      join(outputDir, 'overlay.png'),
    );
  }

  await saveRaster(
    drawDetections(original, bubbles, detectedText),
    join(outputDir, 'detections.png'),
  );

  const beforeDark = countDarkPixels(original);
  const afterDark = countDarkPixels(result.cleaned);
  const report = {
    input: inputPath,
    width: result.width,
    height: result.height,
    bubbleMode,
    bubbles: bubbles.length,
    textRegions: textRegions.length,
    elapsedMs: elapsed,
    methodSummary: result.methodSummary,
    complete: result.complete,
    beforeDark,
    afterDark,
    darkReduction:
      beforeDark === 0 ? 1 : (beforeDark - afterDark) / beforeDark,
    lamaAvailable: Boolean(generative),
    regions: result.regions.map((region) => ({
      id: region.id,
      method: region.method,
      context: region.context,
      success: region.success,
      needsReview: region.needsReview,
      maskPixelCount: region.maskPixelCount,
      methodConfidence: Number(region.methodConfidence.toFixed(3)),
    })),
    warnings: result.warnings,
  };
  await writeFile(
    join(outputDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('methods', result.methodSummary);
  console.log('warnings', result.warnings.length);
  console.log('wrote', outputDir);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
