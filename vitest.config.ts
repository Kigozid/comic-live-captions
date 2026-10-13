import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
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
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Native image processing tests may exceed Vitest's five-second default
    // when multiple image-heavy files execute concurrently.
    testTimeout: 20_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
