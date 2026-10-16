#!/usr/bin/env node
/**
 * Validate lettering removal on comic fixture pages.
 *
 * For each fixture under tests/fixtures/<id>/ with original.png:
 *  1. Detect text regions + bubbles (deterministic / hybrid).
 *  2. Run LetteringRemover (deterministic methods + optional LaMa).
 *  3. Write cleaned.png, removal-mask.png, and a side-by-side compare sheet
 *     under output/lettering-validation/<id>/.
 *  4. Score structural checks against ground-truth cleaned.png when present.
 *
 * Usage:
 *   node --import tsx scripts/validate-lettering.mjs
 *   COMIC_LAMA_URL=http://127.0.0.1:3040 node --import tsx scripts/validate-lettering.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = join(root, 'tests/fixtures');
const outputDir = join(root, 'output/lettering-validation');

const { TextRegionDetector } = await import(
  join(root, 'packages/image-engine/src/text-regions.ts')
);
const { LetteringRemover } = await import(
  join(root, 'packages/image-engine/src/lettering-removal.ts')
);
const { BubbleDetectionEngine } = await import(
  join(root, 'packages/bubble-engine/src/index.ts')
);
const { createImageSpace } = await import(
  join(root, 'packages/shared/src/index.ts')
);
const { LamaHttpProvider } = await import(
  join(root, 'apps/api/src/lama-provider.ts')
);

const FIXTURE_IDS = [
  'simple',
  'ellipse',
  'irregular',
  'narration',
  'overlapping',
  'multiple-bubbles',
  'thought-bubble',
  'long-dialogue',
  'difficult-lettering',
];

async function loadRaster(path) {
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

async function rasterToPng(raster, path) {
  await sharp(
    Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength),
    { raw: { width: raster.width, height: raster.height, channels: 4 } },
  )
    .png()
    .toFile(path);
}

function maskToPng(mask, width, height, path) {
  return sharp(Buffer.from(mask), {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toFile(path);
}

function countDark(raster) {
  let count = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (raster.data[i] < 80 && raster.data[i + 1] < 80 && raster.data[i + 2] < 80)
      count += 1;
  }
  return count;
}

function meanAbsDiff(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum +=
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 3;
  }
  return n === 0 ? 0 : sum / n;
}

async function validateFixture(id, lama) {
  const dir = join(fixturesDir, id);
  const originalPath = join(dir, 'original.png');
  if (!existsSync(originalPath)) {
    return { id, skipped: true, reason: 'missing original.png' };
  }
  const original = await loadRaster(originalPath);
  const space = createImageSpace(`image:fixture-${id}`, original.width, original.height);

  // 1. Independent text regions (kept even when GT is used — GT polygons can
  //    miss overflow lettering outside balloons).
  const textDetector = new TextRegionDetector();
  const textResult = await textDetector.detect(
    new Uint8Array(
      await sharp(originalPath).png().toBuffer(),
    ),
    space,
  );
  const detectedRegions = textResult.regions
    .filter((region) => {
      // Drop page-sized junk "text" regions (panel borders, full bleeds).
      const area = region.boundingBox.width * region.boundingBox.height;
      return area <= original.width * original.height * 0.08;
    })
    .map((region) => ({
      id: region.id,
      boundingBox: region.boundingBox,
      polygon: region.polygon,
      detectionConfidence: region.confidence,
      associatedBubbleId: null,
    }));

  // 2. Bubbles (deterministic geometry).
  let bubbles = [];
  try {
    const bubbleEngine = new BubbleDetectionEngine();
    const cleanedBytes = await sharp(originalPath).png().toBuffer();
    const detection = await bubbleEngine.detect(
      new Uint8Array(cleanedBytes),
      space,
    );
    bubbles = detection.bubbles.map((bubble) => ({
      id: bubble.id,
      contour: bubble.contour,
      interiorHint: 'white-balloon',
    }));
  } catch (error) {
    console.warn(`  bubble detect failed: ${error.message}`);
  }

  // Prefer ground-truth text regions when present (stricter validation of the
  // removal engine itself rather than detection recall). Keep detected regions
  // that GT does not cover so overflow/outside lettering is still removed.
  let textRegions = detectedRegions;
  const gtPath = join(dir, 'ground-truth.json');
  if (existsSync(gtPath)) {
    const gt = JSON.parse(await readFile(gtPath, 'utf8'));
    const gtText = gt.expected?.textRegions ?? [];
    if (gtText.length > 0) {
      const gtRegions = gtText.map((region) => ({
        id: region.id,
        boundingBox: {
          x: region.boundingBox.x,
          y: region.boundingBox.y,
          width: region.boundingBox.width,
          height: region.boundingBox.height,
          coordinateSpace: space,
        },
        ...(region.polygon
          ? {
              polygon: {
                coordinateSpace: space,
                points: region.polygon.map((p) => ({
                  x: p.x,
                  y: p.y,
                  coordinateSpace: space,
                })),
              },
            }
          : {}),
        detectionConfidence: 0.95,
        associatedBubbleId: region.bubbleId ?? bubbles[0]?.id ?? null,
      }));
      const extraDetected = detectedRegions.filter((region) => {
        const box = region.boundingBox;
        return !gtRegions.some((gtRegion) => {
          const g = gtRegion.boundingBox;
          const overlapX =
            Math.max(0, Math.min(box.x + box.width, g.x + g.width) - Math.max(box.x, g.x));
          const overlapY =
            Math.max(0, Math.min(box.y + box.height, g.y + g.height) - Math.max(box.y, g.y));
          const intersection = overlapX * overlapY;
          const union = box.width * box.height + g.width * g.height - intersection;
          return union > 0 && intersection / union > 0.35;
        });
      });
      textRegions = [...gtRegions, ...extraDetected];
    }
    const gtBubbles = gt.expected?.bubbles ?? [];
    if (gtBubbles.length > 0) {
      bubbles = gtBubbles.map((bubble) => ({
        id: bubble.id,
        contour: {
          points: bubble.polygon.map((p) => ({ x: p.x, y: p.y })),
        },
        interiorHint: 'white-balloon',
      }));
    }
  }

  // Character-accurate masks: union GT/detected regions with deterministic
  // ink detection inside each bubble (same path as auto-clean). Tight OCR
  // polygons often clip glyphs; ink capture restores full lettering coverage.
  const { detectTextRegionsForInpaint } = await import(
    join(root, 'packages/image-engine/src/inpaint.ts')
  );
  const inkMasks = detectTextRegionsForInpaint(
    original,
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
  for (const ink of inkMasks) {
    const pixels = ink.pixels;
    const box = ink.boundingBox;
    // Convert the dense ink mask into a region for the remover.
    textRegions.push({
      id: `ink:${ink.id}`,
      mask: pixels,
      boundingBox: box,
      detectionConfidence: ink.confidence,
      associatedBubbleId: ink.bubbleId,
    });
  }

  const remover = new LetteringRemover({
    generative: lama,
  });
  // Force LaMa for designated generative cases so the optional path is
  // exercised even when the background classifies as white-balloon.
  const forceLama = process.env.VALIDATE_FORCE_LAMA === id;
  const result = await remover.removeLettering({
    image: original,
    coordinateSpace: space,
    bubbles: bubbles.map((b) => ({
      ...b,
      contour: {
        points: b.contour.points.map((p) => ({
          x: p.x,
          y: p.y,
          coordinateSpace: space,
        })),
        coordinateSpace: space,
      },
    })),
    textRegions: textRegions.map((region) =>
      forceLama
        ? { ...region, preferredMethod: 'lama' }
        : region,
    ),
    options: {
      expansionPx: 3,
      preferLamaForArtwork: true,
    },
  });

  const out = join(outputDir, id);
  await mkdir(out, { recursive: true });
  await rasterToPng(original, join(out, 'original.png'));
  await rasterToPng(result.cleaned, join(out, 'cleaned.png'));
  await maskToPng(result.removalMask, result.width, result.height, join(out, 'removal-mask.png'));

  // Side-by-side compare sheet: original | cleaned | ground truth.
  const gtCleanedPath = join(dir, 'cleaned.png');
  const panels = [originalPath, join(out, 'cleaned.png')];
  if (existsSync(gtCleanedPath)) panels.push(gtCleanedPath);
  const compare = await sharp({
    create: {
      width: original.width * panels.length,
      height: original.height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });
  const composited = await compare
    .composite(
      await Promise.all(
        panels.map(async (file, index) => ({
          input: await sharp(file).png().toBuffer(),
          left: index * original.width,
          top: 0,
        })),
      ),
    )
    .png()
    .toBuffer();
  await writeFile(join(out, 'compare.png'), composited);

  const beforeDark = countDark(original);
  const afterDark = countDark(result.cleaned);
  let madToGt = null;
  if (existsSync(gtCleanedPath)) {
    const gt = await loadRaster(gtCleanedPath);
    madToGt = meanAbsDiff(result.cleaned, gt);
    await writeFile(
      join(out, 'report.json'),
      JSON.stringify(
        {
          id,
          width: result.width,
          height: result.height,
          regions: result.regions,
          warnings: result.warnings,
          methodSummary: result.methodSummary,
          complete: result.complete,
          beforeDark,
          afterDark,
          madToGroundTruth: madToGt,
          lamaUsed: result.regions.some((r) => r.method === 'lama'),
        },
        null,
        2,
      ),
    );
  } else {
    await writeFile(
      join(out, 'report.json'),
      JSON.stringify(
        {
          id,
          regions: result.regions,
          warnings: result.warnings,
          methodSummary: result.methodSummary,
          complete: result.complete,
          beforeDark,
          afterDark,
        },
        null,
        2,
      ),
    );
  }

  return {
    id,
    width: result.width,
    height: result.height,
    regions: result.regions.length,
    methods: result.methodSummary,
    warnings: result.warnings.map((w) => w.code),
    complete: result.complete,
    beforeDark,
    afterDark,
    darkReduction: beforeDark === 0 ? 1 : (beforeDark - afterDark) / beforeDark,
    madToGroundTruth: madToGt,
  };
}

async function main() {
  const lamaUrl = process.env.COMIC_LAMA_URL ?? 'http://127.0.0.1:3040';
  let lama = null;
  if (process.env.COMIC_LAMA_URL !== 'off') {
    lama = new LamaHttpProvider({ baseUrl: lamaUrl });
    const up = await lama.available();
    console.log(`LaMa service at ${lamaUrl}: ${up ? 'ready' : 'unavailable'}`);
    if (!up) {
      console.log('Falling back to deterministic methods only.');
      lama = null;
    }
  }

  await mkdir(outputDir, { recursive: true });
  const results = [];
  for (const id of FIXTURE_IDS) {
    process.stdout.write(`\n=== ${id} ===\n`);
    try {
      const result = await validateFixture(id, lama);
      results.push(result);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`FAIL ${id}:`, error);
      results.push({ id, error: String(error) });
    }
  }
  await writeFile(
    join(outputDir, 'summary.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(`\nWrote ${outputDir}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
