import type { ImageSpace } from '@comic-captioner/shared';

interface OCRInput {
  readonly image: Uint8Array;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly coordinateSpace: ImageSpace;
}

/** Server-only Gemini adapter. Its output is untrusted until OCRService validates it. */
export class GeminiOCRProvider {
  readonly providerId = 'gemini-ocr';
  readonly providerVersion: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #retryBaseDelayMs: number;

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      fetch?: typeof fetch;
      retryBaseDelayMs?: number;
    } = {},
  ) {
    this.#apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.providerVersion =
      options.model ?? process.env.GEMINI_OCR_MODEL ?? 'gemini-3.8-flash';
    this.#fetch = options.fetch ?? fetch;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  async recognize(input: OCRInput): Promise<unknown> {
    if (!this.#apiKey)
      throw new Error('Gemini OCR is not configured on the API server.');
    const body = JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Read all visible comic lettering on this page. Return JSON with shape {"text":string,"confidence":number,"boundingBox":{"x":number,"y":number,"width":number,"height":number},"blocks":[{"id":string,"text":string,"confidence":number,"boundingBox":bounds,"lines":[{"id":string,"text":string,"confidence":number,"boundingBox":bounds,"words":[{"id":string,"text":string,"confidence":number,"boundingBox":bounds}]}]}]}. Bounds are image pixel-edge coordinates with top-left origin, within ${input.coordinateSpace.dimensions.width}x${input.coordinateSpace.dimensions.height}. Every confidence is 0..1. Keep reading order. IDs must be unique. Do not invent unreadable text; represent uncertain reading literally and lower confidence.`,
            },
            {
              inline_data: {
                mime_type: input.mediaType,
                data: Buffer.from(input.image).toString('base64'),
              },
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json' },
    });
    const fallbackModels = (
      process.env.GEMINI_OCR_FALLBACK_MODELS ??
      'gemini-3.6-flash,gemini-2.5-flash'
    )
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model && model !== this.providerVersion);
    let response!: Response;
    const attemptedModels = [this.providerVersion, ...fallbackModels];
    for (const [modelIndex, model] of attemptedModels.entries()) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await this.#fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': this.#apiKey,
            },
            body,
          });
        } catch (error) {
          throw new Error(
            `Gemini OCR network request failed: ${error instanceof Error ? error.message : 'network error'}`,
          );
        }
        if (response.status !== 503 || attempt >= 2) break;
        const retryAfter = Number(response.headers.get('retry-after')) * 1000;
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 5000)
            : this.#retryBaseDelayMs * 2 ** attempt + Math.random() * 250;
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (response.status !== 503 || modelIndex === attemptedModels.length - 1)
        break;
    }
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404)
        throw new Error(
          `Gemini could not find OCR model "${this.providerVersion}" or it is unavailable to this API key. Set GEMINI_OCR_MODEL to a model enabled for this key.`,
        );
      if (response.status === 503)
        throw new Error(
          `Gemini OCR is temporarily unavailable across the configured models after retries. ${upstreamMessage(result)}`,
        );
      if (response.status === 429)
        throw new Error(
          'Gemini OCR is rate limited after retries. Please wait and try again.',
        );
      throw new Error(
        `Gemini OCR request failed (${response.status}). ${upstreamMessage(result)}`,
      );
    }
    const record = asRecord(result);
    const candidates = Array.isArray(record.candidates)
      ? record.candidates
      : [];
    const first = asRecord(candidates[0]);
    const content = asRecord(first.content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts
      .map((part) => asRecord(part).text)
      .find((part) => typeof part === 'string');
    if (typeof text !== 'string')
      throw new Error('Gemini OCR returned no structured content.');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Gemini OCR returned malformed JSON.');
    }
  }
}

function upstreamMessage(value: unknown): string {
  const message = asRecord(asRecord(value).error).message;
  return typeof message === 'string' && message.length <= 500 ? message : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
