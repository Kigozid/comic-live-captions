import type {
  BubbleDialogueReference,
  DialogueMapping,
  DialogueMappingReason,
  TranscriptSegment,
} from '@comic-captioner/core';
import type { BubbleId } from '@comic-captioner/shared';

export interface DialogueSpeakerHint {
  readonly speakerId: string;
  readonly bubbleId: BubbleId;
  readonly confidence: number;
}

export interface DialogueSemanticScore {
  readonly transcriptSegmentId: string;
  readonly bubbleId: BubbleId;
  /** Optional score from a schema-validated semantic service. */
  readonly score: number;
  readonly evidence?: string;
}

export interface DialogueMappingInput {
  /** OCR text is read from each reference's originalText. */
  readonly bubbleReferences: readonly BubbleDialogueReference[];
  /** Bubble IDs, in the page's intended reading order. */
  readonly readingOrder: readonly BubbleId[];
  /** Transcript segments must be supplied in chronological order. */
  readonly transcriptSegments: readonly TranscriptSegment[];
  readonly speakerHints?: readonly DialogueSpeakerHint[];
  readonly semanticScores?: readonly DialogueSemanticScore[];
}

export interface DialogueMappingOptions {
  readonly minimumConfidence?: number;
  readonly confidentMappingThreshold?: number;
  readonly ambiguityMargin?: number;
  readonly maximumAlternatives?: number;
}

export interface DialogueMappingResult {
  readonly mappings: readonly DialogueMapping[];
  readonly unmappedTranscriptSegmentIds: readonly string[];
}

export class DialogueMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialogueMappingError';
  }
}

const DEFAULTS: Required<DialogueMappingOptions> = {
  minimumConfidence: 0.34,
  confidentMappingThreshold: 0.76,
  ambiguityMargin: 0.12,
  maximumAlternatives: 3,
};

const BASE_WEIGHTS = {
  text: 0.42,
  semantic: 0.2,
  reading: 0.16,
  temporal: 0.08,
  speaker: 0.08,
  spatial: 0.06,
} as const;

/** Deterministic dialogue-to-bubble proposal engine. It never accepts proposals. */
export class DialogueMappingEngine {
  map(
    input: DialogueMappingInput,
    options: DialogueMappingOptions = {},
  ): DialogueMappingResult {
    validateInput(input);
    const config = validateOptions(options);
    const referenceByBubble = new Map(
      input.bubbleReferences.map((reference) => [
        reference.bubbleId,
        reference,
      ]),
    );
    const semantic = new Map(
      (input.semanticScores ?? []).map((item) => [
        pairKey(item.transcriptSegmentId, item.bubbleId),
        item,
      ]),
    );
    const speakerHints = new Map(
      (input.speakerHints ?? []).map((hint) => [
        pairKey(hint.speakerId, hint.bubbleId),
        hint,
      ]),
    );

    const mappings: DialogueMapping[] = [];
    let previousConfident: {
      readonly bubbleId: BubbleId;
      readonly readingIndex: number;
      readonly center: { readonly x: number; readonly y: number };
      readonly speakerId: string | null;
    } | null = null;

    input.transcriptSegments.forEach((segment, segmentIndex) => {
      const candidates = input.readingOrder
        .map((bubbleId, index) => {
          const reference = referenceByBubble.get(bubbleId)!;
          const scores = scoreCandidate({
            segment,
            segmentIndex,
            segmentCount: input.transcriptSegments.length,
            reference,
            readingIndex: index,
            readingCount: input.readingOrder.length,
            previousConfident,
            ...(semantic.has(pairKey(segment.id, bubbleId))
              ? { semantic: semantic.get(pairKey(segment.id, bubbleId))! }
              : {}),
            ...(segment.speakerId &&
            speakerHints.has(pairKey(segment.speakerId, bubbleId))
              ? {
                  speakerHint: speakerHints.get(
                    pairKey(segment.speakerId, bubbleId),
                  )!,
                }
              : {}),
          });
          return { bubbleId, index, reference, ...scores };
        })
        .sort(
          (a, b) =>
            b.confidence - a.confidence ||
            a.index - b.index ||
            String(a.bubbleId).localeCompare(String(b.bubbleId)),
        );

      const winner = candidates[0];
      const runnerUp = candidates[1];
      const margin = winner
        ? winner.confidence - (runnerUp?.confidence ?? 0)
        : 0;
      const hasTextEvidence = (winner?.textScore ?? 0) >= 0.12;
      const hasSemanticEvidence = (winner?.semanticScore ?? 0) >= 0.72;
      const sufficientlySupported = Boolean(
        winner &&
        winner.confidence >= config.minimumConfidence &&
        (hasTextEvidence || hasSemanticEvidence),
      );
      const bubbleId = sufficientlySupported ? winner!.bubbleId : null;
      const ambiguous = Boolean(
        sufficientlySupported &&
        (winner!.confidence < config.confidentMappingThreshold ||
          margin < config.ambiguityMargin),
      );
      const reasons = winner?.reasons ?? [];
      const mapping: DialogueMapping = Object.freeze({
        id: `mapping:${segment.id}`,
        transcriptSegmentId: segment.id,
        bubbleId,
        confidence: winner?.confidence ?? 0,
        reasons: Object.freeze(reasons),
        alternatives: Object.freeze(
          candidates.slice(0, config.maximumAlternatives).map((candidate) =>
            Object.freeze({
              bubbleId: candidate.bubbleId,
              confidence: candidate.confidence,
              reasons: Object.freeze(candidate.reasons),
            }),
          ),
        ),
        needsReview: true,
        reviewFlag: !sufficientlySupported
          ? 'low-confidence'
          : ambiguous
            ? 'ambiguous'
            : 'review-required',
        status: 'pending-review',
        revision: 1,
      });
      mappings.push(mapping);

      if (bubbleId && winner!.confidence >= config.confidentMappingThreshold) {
        previousConfident = {
          bubbleId,
          readingIndex: winner!.index,
          center: boundsCenter(winner!.reference),
          speakerId: segment.speakerId,
        };
      }
    });

    return Object.freeze({
      mappings: Object.freeze(mappings),
      unmappedTranscriptSegmentIds: Object.freeze(
        mappings
          .filter((mapping) => mapping.bubbleId === null)
          .map((mapping) => mapping.transcriptSegmentId),
      ),
    });
  }
}

function scoreCandidate(input: {
  readonly segment: TranscriptSegment;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly reference: BubbleDialogueReference;
  readonly readingIndex: number;
  readonly readingCount: number;
  readonly previousConfident: {
    readonly bubbleId: BubbleId;
    readonly readingIndex: number;
    readonly center: { readonly x: number; readonly y: number };
    readonly speakerId: string | null;
  } | null;
  readonly semantic?: DialogueSemanticScore;
  readonly speakerHint?: DialogueSpeakerHint;
}): {
  readonly confidence: number;
  readonly textScore: number;
  readonly semanticScore?: number;
  readonly reasons: readonly DialogueMappingReason[];
} {
  const textScore = textSimilarity(
    input.segment.text,
    input.reference.originalText,
  );
  const readingScore = rankSimilarity(
    input.segmentIndex,
    input.segmentCount,
    input.readingIndex,
    input.readingCount,
  );
  const reasons: DialogueMappingReason[] = [
    reason(
      'text-similarity',
      textScore,
      textScore >= 0.99
        ? 'Transcript text matches the OCR dialogue.'
        : `Normalized text overlap is ${Math.round(textScore * 100)}%.`,
    ),
    reason(
      'reading-order',
      readingScore,
      `Transcript turn ${input.segmentIndex + 1} is compared with page reading position ${input.readingIndex + 1}.`,
    ),
  ];

  let weightedScore =
    textScore * BASE_WEIGHTS.text + readingScore * BASE_WEIGHTS.reading;
  let totalWeight = BASE_WEIGHTS.text + BASE_WEIGHTS.reading;

  if (input.semantic) {
    weightedScore += input.semantic.score * BASE_WEIGHTS.semantic;
    totalWeight += BASE_WEIGHTS.semantic;
    reasons.push(
      reason(
        'semantic-similarity',
        input.semantic.score,
        input.semantic.evidence ??
          'Validated semantic similarity supplied by an optional semantic service.',
      ),
    );
  }

  if (input.previousConfident) {
    const temporalScore =
      input.readingIndex >= input.previousConfident.readingIndex
        ? 1
        : Math.max(
            0,
            1 -
              (input.previousConfident.readingIndex - input.readingIndex) /
                Math.max(1, input.readingCount - 1),
          );
    weightedScore += temporalScore * BASE_WEIGHTS.temporal;
    totalWeight += BASE_WEIGHTS.temporal;
    reasons.push(
      reason(
        'temporal-order',
        temporalScore,
        temporalScore === 1
          ? 'This candidate preserves chronological transcript order.'
          : 'This candidate would move backward in page reading order.',
      ),
    );

    const referenceCenter = boundsCenter(input.reference);
    const space = input.reference.originalTextBounds.coordinateSpace;
    const diagonal = Math.hypot(
      space.dimensions.width,
      space.dimensions.height,
    );
    const distance = Math.hypot(
      referenceCenter.x - input.previousConfident.center.x,
      referenceCenter.y - input.previousConfident.center.y,
    );
    const spatialScore = Math.max(0, Math.min(1, 1 - distance / diagonal));
    weightedScore += spatialScore * BASE_WEIGHTS.spatial;
    totalWeight += BASE_WEIGHTS.spatial;
    reasons.push(
      reason(
        'spatial-context',
        spatialScore,
        `Text centers are ${Math.round(distance)} image pixels apart in the shared page ImageSpace.`,
      ),
    );
  }

  if (input.speakerHint) {
    const speakerScore = input.speakerHint.confidence;
    weightedScore += speakerScore * BASE_WEIGHTS.speaker;
    totalWeight += BASE_WEIGHTS.speaker;
    reasons.push(
      reason(
        'speaker-consistency',
        speakerScore,
        `Speaker ${input.segment.speakerId} is associated with this bubble by a reviewed speaker hint.`,
      ),
    );
  } else if (
    input.segment.speakerId &&
    input.previousConfident?.speakerId === input.segment.speakerId
  ) {
    const consistency =
      input.previousConfident.bubbleId === input.reference.bubbleId ? 1 : 0.45;
    weightedScore += consistency * BASE_WEIGHTS.speaker;
    totalWeight += BASE_WEIGHTS.speaker;
    reasons.push(
      reason(
        'speaker-consistency',
        consistency,
        consistency === 1
          ? 'This matches the bubble proposed for the same speaker’s previous turn.'
          : 'The same speaker previously mapped to another bubble.',
      ),
    );
  }

  return {
    confidence: clamp(weightedScore / totalWeight),
    textScore,
    ...(input.semantic ? { semanticScore: input.semantic.score } : {}),
    reasons: Object.freeze(reasons),
  };
}

function textSimilarity(left: string, right: string): number {
  const a = normalizeTokens(left);
  const b = normalizeTokens(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  const aSet = new Set(a);
  const bSet = new Set(b);
  const intersection = [...aSet].filter((token) => bSet.has(token)).length;
  const tokenDice = (2 * intersection) / (aSet.size + bSet.size);
  const compactA = a.join('');
  const compactB = b.join('');
  const ngramsA = characterNgrams(compactA, 3);
  const ngramsB = characterNgrams(compactB, 3);
  const ngramIntersection = [...ngramsA].filter((gram) =>
    ngramsB.has(gram),
  ).length;
  const ngramDice =
    ngramsA.size + ngramsB.size === 0
      ? Number(compactA === compactB)
      : (2 * ngramIntersection) / (ngramsA.size + ngramsB.size);
  return clamp(tokenDice * 0.65 + ngramDice * 0.35);
}

function normalizeTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function characterNgrams(value: string, size: number): Set<string> {
  const padded = ` ${value} `;
  const grams = new Set<string>();
  for (let i = 0; i <= padded.length - size; i += 1) {
    grams.add(padded.slice(i, i + size));
  }
  return grams;
}

function rankSimilarity(
  segmentIndex: number,
  segmentCount: number,
  bubbleIndex: number,
  bubbleCount: number,
): number {
  if (segmentCount <= 1 || bubbleCount <= 1) return 1;
  const expected = (segmentIndex / (segmentCount - 1)) * (bubbleCount - 1);
  return Math.max(
    0,
    1 - Math.abs(bubbleIndex - expected) / Math.max(1, bubbleCount - 1),
  );
}

function boundsCenter(reference: BubbleDialogueReference) {
  const bounds = reference.originalTextBounds;
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function reason(
  signal: DialogueMappingReason['signal'],
  score: number,
  evidence: string,
): DialogueMappingReason {
  return Object.freeze({ signal, score: clamp(score), evidence });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

function validateInput(input: DialogueMappingInput): void {
  if (
    !Array.isArray(input.bubbleReferences) ||
    !Array.isArray(input.readingOrder) ||
    !Array.isArray(input.transcriptSegments)
  ) {
    throw new DialogueMappingError(
      'References, reading order, and transcript segments are required.',
    );
  }
  const references = new Map<string, BubbleDialogueReference>();
  for (const reference of input.bubbleReferences) {
    if (!reference.bubbleId || references.has(reference.bubbleId)) {
      throw new DialogueMappingError(
        'Bubble dialogue references must have unique bubble IDs.',
      );
    }
    const bounds = reference.originalTextBounds;
    const space = bounds.coordinateSpace;
    if (
      space.kind !== 'image' ||
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.x < -0.5 ||
      bounds.y < -0.5 ||
      bounds.x + bounds.width > space.dimensions.width - 0.5 ||
      bounds.y + bounds.height > space.dimensions.height - 0.5 ||
      !Number.isFinite(reference.confidence) ||
      reference.confidence < 0 ||
      reference.confidence > 1
    ) {
      throw new DialogueMappingError(
        'OCR dialogue bounds and confidence must be valid in their declared ImageSpace.',
      );
    }
    references.set(reference.bubbleId, reference);
  }
  const firstSpace =
    input.bubbleReferences[0]?.originalTextBounds.coordinateSpace;
  if (
    firstSpace &&
    input.bubbleReferences.some((reference) => {
      const space = reference.originalTextBounds.coordinateSpace;
      return (
        space.id !== firstSpace.id ||
        space.dimensions.width !== firstSpace.dimensions.width ||
        space.dimensions.height !== firstSpace.dimensions.height
      );
    })
  ) {
    throw new DialogueMappingError(
      'All OCR dialogue bounds must use the same page ImageSpace.',
    );
  }
  if (
    new Set(input.readingOrder).size !== input.readingOrder.length ||
    input.readingOrder.length !== references.size ||
    input.readingOrder.some((id) => !references.has(id))
  ) {
    throw new DialogueMappingError(
      'Reading order must list every referenced bubble exactly once.',
    );
  }
  const segmentIds = new Set<string>();
  let previousStart = Number.NEGATIVE_INFINITY;
  let timebase: string | undefined;
  let timeUnit: string | undefined;
  for (const segment of input.transcriptSegments) {
    const start = segment.interval.start.value;
    const end = segment.interval.end.value;
    if (!segment.id || segmentIds.has(segment.id)) {
      throw new DialogueMappingError(
        'Transcript segments must have unique non-empty IDs.',
      );
    }
    if (
      !segment.text.trim() ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      start < previousStart ||
      segment.interval.start.timebase !== segment.interval.end.timebase ||
      segment.interval.start.unit !== segment.interval.end.unit
    ) {
      throw new DialogueMappingError(
        'Transcript segments must have text and valid chronological intervals in one timebase.',
      );
    }
    if (
      (timebase !== undefined &&
        timebase !== segment.interval.start.timebase) ||
      (timeUnit !== undefined && timeUnit !== segment.interval.start.unit)
    ) {
      throw new DialogueMappingError(
        'Transcript segments must share one audio timebase and unit.',
      );
    }
    segmentIds.add(segment.id);
    previousStart = start;
    timebase = segment.interval.start.timebase;
    timeUnit = segment.interval.start.unit;
  }
  const speakerKeys = new Set<string>();
  for (const hint of input.speakerHints ?? []) {
    if (
      !hint.speakerId ||
      !references.has(hint.bubbleId) ||
      !validScore(hint.confidence) ||
      speakerKeys.has(pairKey(hint.speakerId, hint.bubbleId))
    ) {
      throw new DialogueMappingError(
        'Speaker hints must be unique, reference known bubbles, and have confidence in [0, 1].',
      );
    }
    speakerKeys.add(pairKey(hint.speakerId, hint.bubbleId));
  }
  const semanticKeys = new Set<string>();
  for (const score of input.semanticScores ?? []) {
    const key = pairKey(score.transcriptSegmentId, score.bubbleId);
    if (
      !segmentIds.has(score.transcriptSegmentId) ||
      !references.has(score.bubbleId) ||
      !validScore(score.score) ||
      semanticKeys.has(key)
    ) {
      throw new DialogueMappingError(
        'Semantic scores must be unique, reference known segments and bubbles, and be in [0, 1].',
      );
    }
    semanticKeys.add(key);
  }
}

function validateOptions(
  options: DialogueMappingOptions,
): Required<DialogueMappingOptions> {
  const config = { ...DEFAULTS, ...options };
  if (
    !validScore(config.minimumConfidence) ||
    !validScore(config.confidentMappingThreshold) ||
    !validScore(config.ambiguityMargin) ||
    !Number.isInteger(config.maximumAlternatives) ||
    config.maximumAlternatives < 1 ||
    config.maximumAlternatives > 20
  ) {
    throw new DialogueMappingError(
      'Mapping thresholds must be within [0, 1] and alternatives must be between 1 and 20.',
    );
  }
  return config;
}

function validScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
