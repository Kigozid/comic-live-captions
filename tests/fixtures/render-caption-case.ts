import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { RenderingEngine } from '@comic-captioner/rendering';
import {
  CAPTION_VISUAL_CASES,
  createVisualLayouts,
} from './caption-visual-cases.js';
import type { ComicFixtureGroundTruth } from './suite.js';

export const VISUAL_REFERENCE_DIRECTORY = path.resolve(
  process.cwd(),
  'tests/fixtures/visual-regression/caption-renderer/references',
);

/** Manifest of approved font-independent caption structure, beside the PNGs. */
export const VISUAL_APPROVED_STRUCTURE_PATH = path.resolve(
  process.cwd(),
  'tests/fixtures/visual-regression/caption-renderer/approved-structure.json',
);

export async function renderCaptionVisualCase(caseId: string) {
  const testCase = CAPTION_VISUAL_CASES.find(
    (candidate) => candidate.id === caseId,
  );
  if (!testCase) throw new Error(`Unknown caption visual case: ${caseId}`);
  const fixtureDirectory = path.resolve(
    process.cwd(),
    'tests/fixtures',
    testCase.fixture,
  );
  const truth = JSON.parse(
    await readFile(path.join(fixtureDirectory, 'ground-truth.json'), 'utf8'),
  ) as ComicFixtureGroundTruth;
  const page = await readFile(path.join(fixtureDirectory, 'cleaned.png'));
  const layouts = createVisualLayouts(truth, testCase);
  const output = await new RenderingEngine().renderPng(page, layouts);
  const decoded = await sharp(output)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleaned = await sharp(page)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    output,
    width: decoded.info.width,
    height: decoded.info.height,
    rgba: decoded.data,
    cleanedRgba: cleaned.data,
    layouts,
    truth,
  };
}
