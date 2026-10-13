import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPTION_VISUAL_CASES } from '../fixtures/caption-visual-cases.js';
import {
  renderCaptionVisualCase,
  VISUAL_REFERENCE_DIRECTORY,
} from '../fixtures/render-caption-case.js';

const explicitUpdate = process.env.CAPTION_RENDERER_UPDATE_SNAPSHOTS === '1';

describe('intentional caption renderer reference updates', () => {
  it.skipIf(!explicitUpdate)(
    'rewrites references only when the explicit update command is used',
    async () => {
      await mkdir(VISUAL_REFERENCE_DIRECTORY, { recursive: true });
      for (const testCase of CAPTION_VISUAL_CASES) {
        const { output } = await renderCaptionVisualCase(testCase.id);
        const target = path.join(
          VISUAL_REFERENCE_DIRECTORY,
          `${testCase.id}.png`,
        );
        await writeFile(target, output);
        console.log(`Updated approved caption renderer reference: ${target}`);
      }
      expect(CAPTION_VISUAL_CASES.length).toBeGreaterThan(0);
    },
  );
});
