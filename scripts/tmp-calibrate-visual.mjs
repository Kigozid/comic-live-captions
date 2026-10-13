import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { CAPTION_VISUAL_CASES } from '../tests/fixtures/caption-visual-cases.js';
import { renderCaptionVisualCase } from '../tests/fixtures/render-caption-case.js';

const INK_THRESHOLD = 24;

function inkMask(fg, bg, pixels) {
  const mask = new Uint8Array(pixels);
  let count = 0;
  for (let i = 0; i < pixels; i += 1) {
    let changed = false;
    for (let c = 0; c < 4; c += 1) {
      if (Math.abs(fg[i * 4 + c] - bg[i * 4 + c]) > INK_THRESHOLD) changed = true;
    }
    if (changed) {
      mask[i] = 1;
      count += 1;
    }
  }
  return { mask, count };
}

function countInBox(mask, width, box) {
  let count = 0;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width - 1, Math.ceil(box.x + box.width));
  const y1 = Math.min(mask.length / width - 1, Math.ceil(box.y + box.height));
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) if (mask[y * width + x]) count += 1;
  return count;
}

function inflate(box, margin) {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  };
}

for (const testCase of CAPTION_VISUAL_CASES) {
  const fixtureDirectory = path.resolve('tests/fixtures', testCase.fixture);
  const truth = JSON.parse(
    await readFile(path.join(fixtureDirectory, 'ground-truth.json'), 'utf8'),
  );
  const pageBytes = await readFile(path.join(fixtureDirectory, 'cleaned.png'));
  const page = await sharp(pageBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const referenceBytes = await readFile(
    path.join(
      'tests/fixtures/visual-regression/caption-renderer/references',
      `${testCase.id}.png`,
    ),
  );
  const reference = await sharp(referenceBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = await renderCaptionVisualCase(testCase.id);
  const width = reference.info.width;
  const height = reference.info.height;
  const pixels = width * height;
  const refInk = inkMask(reference.data, page.data, pixels);
  const actInk = inkMask(result.rgba, page.data, pixels);
  console.log(`\n== ${testCase.id} (${width}x${height}) ink ref=${refInk.count} act=${actInk.count}`);
  for (const layout of result.layouts) {
    const region = truth.expected.textRegions.find((r) => r.bubbleId === layout.bubbleId);
    const regionBox = inflate(region.boundingBox, 2);
    let regionInk = 0;
    let outside = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!actInk.mask[y * width + x]) continue;
        const inside =
          x >= regionBox.x && x < regionBox.x + regionBox.width &&
          y >= regionBox.y && y < regionBox.y + regionBox.height;
        if (inside) regionInk += 1;
        else outside += 1;
      }
    }
    for (const line of layout.linePlacements) {
      const box = {
        x: line.position.x,
        y: line.position.y,
        width: line.widthPx,
        height: line.heightPx,
      };
      const margins = [0, 4, Math.round(layout.fontSizePx * 0.35) + 4];
      const counts = margins.map((m) => {
        const b = inflate(box, m);
        return {
          margin: m,
          ref: countInBox(refInk.mask, width, b),
          act: countInBox(actInk.mask, width, b),
        };
      });
      console.log(
        `  line "${line.text}" fontSize=${layout.fontSizePx.toFixed(1)} box=${JSON.stringify(box)}`,
      );
      for (const c of counts)
        console.log(`    margin=${c.margin} refInk=${c.ref} actInk=${c.act}`);
    }
    console.log(`  regionInk=${regionInk} outside=${outside} regionBox=${JSON.stringify(regionBox)}`);
  }
}
