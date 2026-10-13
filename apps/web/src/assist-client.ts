export type AssistTask =
  | 'ocr-correction'
  | 'bubble-classification'
  | 'dialogue-mapping'
  | 'speaker-context'
  | 'transcription-correction';
export type AssistValue =
  | Readonly<{ text: string }>
  | Readonly<{ classification: 'speech' | 'thought' | 'narration' | 'unknown' }>
  | Readonly<{ bubbleId: string }>
  | Readonly<{ speakerId: string; context: string }>;
export interface AssistProposal {
  readonly id: string;
  readonly task: AssistTask;
  readonly targetId: string;
  readonly suggestion: AssistValue;
  readonly confidence: number;
  readonly rationale: string;
  readonly provenance: Readonly<{ provider: string; model: string }>;
  readonly status: 'pending-review';
}

export async function requestAssist(
  input: {
    readonly task: AssistTask;
    readonly targetId: string;
    readonly context: Readonly<Record<string, unknown>>;
  },
  signal?: AbortSignal,
): Promise<AssistProposal> {
  const response = await fetch('/api/assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      isObject(payload) &&
      isObject(payload.error) &&
      typeof payload.error.message === 'string'
        ? payload.error.message
        : 'Gemini Assist could not complete this request.';
    throw new Error(message);
  }
  if (!isObject(payload) || !isObject(payload.proposal))
    throw new Error('The assistance result was malformed.');
  return validateProposal(payload.proposal, input);
}

function validateProposal(
  value: Record<string, unknown>,
  input: {
    task: AssistTask;
    targetId: string;
    context: Readonly<Record<string, unknown>>;
  },
): AssistProposal {
  if (
    value.task !== input.task ||
    value.targetId !== input.targetId ||
    value.status !== 'pending-review' ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.rationale !== 'string' ||
    !value.rationale.trim() ||
    !isObject(value.suggestion) ||
    !isObject(value.provenance) ||
    typeof value.provenance.provider !== 'string' ||
    typeof value.provenance.model !== 'string'
  )
    throw new Error('The assistance proposal failed validation.');
  const suggestion = value.suggestion;
  if (
    input.task === 'ocr-correction' ||
    input.task === 'transcription-correction'
  ) {
    if (typeof suggestion.text !== 'string' || !suggestion.text.trim())
      throw new Error('The suggested text failed validation.');
  } else if (input.task === 'bubble-classification') {
    if (
      !['speech', 'thought', 'narration', 'unknown'].includes(
        String(suggestion.classification),
      )
    )
      throw new Error('The suggested bubble type failed validation.');
  } else if (input.task === 'dialogue-mapping') {
    if (
      typeof suggestion.bubbleId !== 'string' ||
      !Array.isArray(input.context.candidateBubbleIds) ||
      !input.context.candidateBubbleIds.includes(suggestion.bubbleId)
    )
      throw new Error('The suggested bubble is not a valid candidate.');
  } else if (
    typeof suggestion.speakerId !== 'string' ||
    typeof suggestion.context !== 'string'
  )
    throw new Error('The speaker suggestion failed validation.');
  return value as unknown as AssistProposal;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
