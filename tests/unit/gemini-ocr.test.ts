import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import { GeminiOCRProvider } from '@comic-captioner/ai';

const input = {
  image: new Uint8Array([1, 2, 3]),
  mediaType: 'image/png' as const,
  coordinateSpace: createImageSpace('ocr-test', 10, 10),
};

describe('Gemini OCR provider', () => {
  it('switches to the next configured model after retryable service overload', async () => {
    const models: string[] = [];
    const provider = new GeminiOCRProvider({
      apiKey: 'test-key',
      model: 'primary-model',
      retryBaseDelayMs: 0,
      fetch: async (inputUrl) => {
        models.push(String(inputUrl).match(/models\/([^:]+)/)?.[1] ?? '');
        if (models.length <= 3)
          return Response.json(
            { error: { message: 'overloaded' } },
            { status: 503 },
          );
        return Response.json({
          candidates: [{ content: { parts: [{ text: '{"text":"Hi"}' }] } }],
        });
      },
    });
    await expect(provider.recognize(input)).resolves.toEqual({ text: 'Hi' });
    expect(models).toEqual([
      'primary-model',
      'primary-model',
      'primary-model',
      'gemini-3.6-flash',
    ]);
  });

  it('includes Gemini upstream details after fallback models are also unavailable', async () => {
    const provider = new GeminiOCRProvider({
      apiKey: 'test-key',
      model: 'primary-model',
      retryBaseDelayMs: 0,
      fetch: async () =>
        Response.json(
          { error: { message: 'capacity exhausted' } },
          { status: 503 },
        ),
    });
    await expect(provider.recognize(input)).rejects.toThrow(
      /capacity exhausted/,
    );
  });
});
