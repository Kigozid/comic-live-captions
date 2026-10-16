import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '@comic-captioner/shared/ocr-preprocessing': fileURLToPath(
    new URL('./packages/shared/src/ocr-preprocessing.ts', import.meta.url),
  ),
  '@comic-captioner/shared': fileURLToPath(
    new URL('./packages/shared/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/core': fileURLToPath(
    new URL('./packages/core/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/image-engine': fileURLToPath(
    new URL('./packages/image-engine/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/bubble-engine': fileURLToPath(
    new URL('./packages/bubble-engine/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/audio-engine': fileURLToPath(
    new URL('./packages/audio-engine/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/ai': fileURLToPath(
    new URL('./packages/ai/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/caption-engine': fileURLToPath(
    new URL('./packages/caption-engine/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/rendering': fileURLToPath(
    new URL('./packages/rendering/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/video-composer': fileURLToPath(
    new URL('./packages/video-composer/src/index.ts', import.meta.url),
  ),
  '@comic-captioner/video-composer/remotion': fileURLToPath(
    new URL('./packages/video-composer/src/remotion/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
          testTimeout: 20_000,
          restoreMocks: true,
          clearMocks: true,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // ONNX / FFmpeg / Paddle paths contend for CPU when several
          // integration files share a worker pool. Serialize the suite and
          // allow cold-start model loads so speech-automation no longer flakes.
          fileParallelism: false,
          testTimeout: 60_000,
          restoreMocks: true,
          clearMocks: true,
        },
      },
    ],
  },
});
