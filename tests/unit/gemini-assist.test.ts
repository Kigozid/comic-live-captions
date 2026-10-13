import { describe, expect, it } from 'vitest';
import {
  AssistError,
  GeminiAssistProvider,
  GeminiAssistService,
} from '@comic-captioner/ai';
import type { AssistInput, AssistProvider } from '@comic-captioner/ai';

class FakeProvider implements AssistProvider {
  readonly providerId = 'fake';
  readonly version = 'test';
  constructor(private readonly result: unknown) {}
  async analyze(): Promise<unknown> {
    return this.result;
  }
}

const request: AssistInput = {
  task: 'ocr-correction',
  targetId: 'ocr-1',
  context: { text: 'Helo' },
};

describe('Gemini Assist proposals', () => {
  it('returns schema-validated pending proposals without applying them', async () => {
    const service = new GeminiAssistService(
      new FakeProvider({
        suggestion: { text: 'Hello' },
        confidence: 0.92,
        rationale: 'Corrects an obvious spelling error.',
      }),
    );
    const proposal = await service.propose(request);
    expect(proposal).toMatchObject({
      task: 'ocr-correction',
      targetId: 'ocr-1',
      suggestion: { text: 'Hello' },
      confidence: 0.92,
      status: 'pending-review',
      provenance: { provider: 'fake', model: 'test' },
    });
  });

  it('rejects malformed confidence, unsupported classifications, and unmapped IDs', async () => {
    await expect(
      new GeminiAssistService(
        new FakeProvider({
          suggestion: { text: 'Hello' },
          confidence: 1.2,
          rationale: 'x',
        }),
      ).propose(request),
    ).rejects.toThrow(AssistError);
    await expect(
      new GeminiAssistService(
        new FakeProvider({
          suggestion: { classification: 'balloon' },
          confidence: 0.8,
          rationale: 'x',
        }),
      ).propose({ ...request, task: 'bubble-classification' }),
    ).rejects.toThrow(AssistError);
    await expect(
      new GeminiAssistService(
        new FakeProvider({
          suggestion: { bubbleId: 'foreign' },
          confidence: 0.8,
          rationale: 'x',
        }),
      ).propose({
        task: 'dialogue-mapping',
        targetId: 'dialogue-1',
        context: { candidateBubbleIds: ['bubble-a'] },
      }),
    ).rejects.toThrow(AssistError);
  });

  it('keeps credentials server-side and parses structured provider output', async () => {
    let sentBody = '';
    const provider = new GeminiAssistProvider({
      apiKey: 'server-only',
      fetch: async (_url, init) => {
        sentBody = String(init?.body);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        suggestion: { text: 'Hello' },
                        confidence: 0.9,
                        rationale: 'Spelling correction.',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const result = (await provider.analyze(request)) as {
      suggestion: { text: string };
    };
    expect(result.suggestion.text).toBe('Hello');
    expect(sentBody).not.toContain('server-only');
  });
});
