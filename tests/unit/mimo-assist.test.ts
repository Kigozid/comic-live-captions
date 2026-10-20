import { describe, expect, it } from 'vitest';
import {
  AssistError,
  AssistService,
  MimoAssistProvider,
} from '@comic-captioner/ai';
import type { AssistInput } from '@comic-captioner/ai';

const request: AssistInput = {
  task: 'dialogue-mapping',
  targetId: 'segment-1',
  context: {
    candidateBubbleIds: ['bubble-a', 'bubble-b'],
    transcriptText: 'Where did you learn that?',
  },
};

describe('MimoAssistProvider', () => {
  it('sends OpenAI-compatible chat completions and parses JSON content', async () => {
    let sentUrl = '';
    let sentAuth = '';
    let sentBody = '';
    const provider = new MimoAssistProvider({
      apiKey: 'mimo-secret',
      baseUrl: 'https://mimo.example/v1',
      model: 'mimo-test',
      fetch: async (url, init) => {
        sentUrl = String(url);
        sentAuth = String(
          (init?.headers as Record<string, string>)?.authorization ?? '',
        );
        sentBody = String(init?.body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    suggestion: { bubbleId: 'bubble-a' },
                    confidence: 0.81,
                    rationale: 'Text matches the left balloon.',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const raw = (await provider.analyze(request)) as {
      suggestion: { bubbleId: string };
    };
    expect(raw.suggestion.bubbleId).toBe('bubble-a');
    expect(sentUrl).toBe('https://mimo.example/v1/chat/completions');
    expect(sentAuth).toBe('Bearer mimo-secret');
    expect(sentBody).toContain('dialogue-mapping');
    expect(sentBody).not.toContain('mimo-secret');
  });

  it('returns reviewable proposals through AssistService', async () => {
    const provider = new MimoAssistProvider({
      apiKey: 'k',
      baseUrl: 'https://mimo.example/v1',
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '```json\n' +
                    JSON.stringify({
                      suggestion: { bubbleId: 'bubble-b' },
                      confidence: 0.7,
                      rationale: 'Reading-order match.',
                    }) +
                    '\n```',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    const proposal = await new AssistService(provider).propose(request);
    expect(proposal).toMatchObject({
      task: 'dialogue-mapping',
      targetId: 'segment-1',
      suggestion: { bubbleId: 'bubble-b' },
      status: 'pending-review',
      provenance: { provider: 'mimo' },
    });
  });

  it('rejects unmapped bubble IDs and missing credentials', async () => {
    const provider = new MimoAssistProvider({
      apiKey: 'k',
      baseUrl: 'https://mimo.example/v1',
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    suggestion: { bubbleId: 'foreign' },
                    confidence: 0.9,
                    rationale: 'x',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    await expect(new AssistService(provider).propose(request)).rejects.toThrow(
      AssistError,
    );
    await expect(
      new MimoAssistProvider({ apiKey: '', baseUrl: '' }).analyze(request),
    ).rejects.toThrow(/not configured/i);
  });
});
