import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyOCRCorrection,
  buildReviewQueue,
  mergeOcrPasses,
  OCRError,
  parseOCRDocument,
  summarizeTriage,
} from '@comic-captioner/image-engine';
import {
  createImageSpace,
  type Bounds,
  type ImageSpace,
  type OCRDocument,
} from '@comic-captioner/shared';

const space = createImageSpace('triage-page', 200, 120);

interface WordSpec {
  readonly id: string;
  readonly text: string;
  readonly confidence: number;
  readonly box: readonly [number, number, number, number];
}

interface LineSpec {
  readonly id: string;
  readonly text: string;
  readonly confidence: number;
  readonly words: readonly WordSpec[];
}

function bounds(
  x: number,
  y: number,
  width: number,
  height: number,
  coordinateSpace: ImageSpace = space,
): Bounds<ImageSpace> {
  return { x, y, width, height, coordinateSpace };
}

function unionBox(boxes: readonly Bounds<ImageSpace>[]): Bounds<ImageSpace> {
  const x0 = Math.min(...boxes.map((box) => box.x));
  const y0 = Math.min(...boxes.map((box) => box.y));
  const x1 = Math.max(...boxes.map((box) => box.x + box.width));
  const y1 = Math.max(...boxes.map((box) => box.y + box.height));
  return bounds(x0, y0, x1 - x0, y1 - y0);
}

function fullPageBox(
  coordinateSpace: ImageSpace = space,
): Bounds<ImageSpace> {
  return bounds(
    -0.5,
    -0.5,
    coordinateSpace.dimensions.width,
    coordinateSpace.dimensions.height,
    coordinateSpace,
  );
}

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function documentFrom(spec: {
  id: string;
  source: string;
  confidence: number;
  lines: readonly LineSpec[];
}): OCRDocument {
  const blocks =
    spec.lines.length === 0
      ? []
      : [
          {
            id: `${spec.id}-block`,
            text: spec.lines.map((line) => line.text).join('\n'),
            boundingBox: unionBox(
              spec.lines.map((line) =>
                unionBox(
                  line.words.map((word) =>
                    bounds(...word.box),
                  ),
                ),
              ),
            ),
            confidence:
              spec.lines.reduce((sum, line) => sum + line.confidence, 0) /
              spec.lines.length,
            coordinateSpace: space,
            lines: spec.lines.map((line) => ({
              id: line.id,
              text: line.text,
              boundingBox: unionBox(
                line.words.map((word) => bounds(...word.box)),
              ),
              confidence: line.confidence,
              coordinateSpace: space,
              words: line.words.map((word) => ({
                id: word.id,
                text: word.text,
                boundingBox: bounds(...word.box),
                confidence: word.confidence,
                coordinateSpace: space,
              })),
            })),
          },
        ];
  return parseOCRDocument(
    {
      id: spec.id,
      text: spec.lines.map((line) => line.text).join('\n\n'),
      boundingBox: fullPageBox(),
      confidence: spec.confidence,
      coordinateSpace: space,
      blocks,
    },
    space,
    { source: spec.source, version: '1', inputHashes: [hash(spec.source[0] ?? 'a')] },
  );
}

function emptyDocument(id: string, source: string, confidence: number) {
  return documentFrom({ id, source, confidence, lines: [] });
}

function singleWordDocument(options: {
  id: string;
  source: string;
  word: WordSpec;
  lineId?: string;
  lineConfidence?: number;
  documentConfidence?: number;
}): OCRDocument {
  return documentFrom({
    id: options.id,
    source: options.source,
    confidence: options.documentConfidence ?? options.word.confidence,
    lines: [
      {
        id: options.lineId ?? `${options.word.id}-line`,
        text: options.word.text,
        confidence: options.lineConfidence ?? options.word.confidence,
        words: [options.word],
      },
    ],
  });
}

describe('mergeOcrPasses', () => {
  it('boosts confidence when both passes agree on text', () => {
    const passA = singleWordDocument({
      id: 'doc-a',
      source: 'a',
      word: {
        id: 'word-1',
        text: 'HELLO',
        confidence: 0.7,
        box: [10, 10, 50, 16],
      },
    });
    const passB = singleWordDocument({
      id: 'doc-b',
      source: 'b',
      word: {
        id: 'word-1',
        text: 'hello',
        confidence: 0.75,
        box: [11, 10, 50, 16],
      },
    });

    const merged = mergeOcrPasses(passA, passB);
    const word = merged.blocks[0]?.lines[0]?.words[0];
    expect(word?.text).toBe('hello');
    expect(word?.confidence).toBeCloseTo(0.85, 10);
    expect(merged.blocks[0]?.lines[0]?.confidence).toBeCloseTo(0.85, 10);
    expect(merged.reviewStatus).toBe('pending-review');
  });

  it('keeps the higher-confidence text and lowers confidence when passes disagree', () => {
    const strongerA = singleWordDocument({
      id: 'doc-a',
      source: 'a',
      word: {
        id: 'word-1',
        text: 'HELL0',
        confidence: 0.9,
        box: [10, 10, 50, 16],
      },
    });
    const weakerB = singleWordDocument({
      id: 'doc-b',
      source: 'b',
      word: {
        id: 'word-1',
        text: 'HELLO',
        confidence: 0.6,
        box: [10, 10, 50, 16],
      },
    });

    const merged = mergeOcrPasses(strongerA, weakerB);
    const word = merged.blocks[0]?.lines[0]?.words[0];
    expect(word?.text).toBe('HELL0');
    expect(word?.confidence).toBeCloseTo(0.7, 10);

    const flipped = mergeOcrPasses(
      singleWordDocument({
        id: 'doc-a',
        source: 'a',
        word: {
          id: 'word-1',
          text: 'HELL0',
          confidence: 0.6,
          box: [10, 10, 50, 16],
        },
      }),
      singleWordDocument({
        id: 'doc-b',
        source: 'b',
        word: {
          id: 'word-1',
          text: 'HELLO',
          confidence: 0.9,
          box: [10, 10, 50, 16],
        },
      }),
    );
    expect(flipped.blocks[0]?.lines[0]?.words[0]?.text).toBe('HELLO');
    expect(flipped.blocks[0]?.lines[0]?.words[0]?.confidence).toBeCloseTo(
      0.7,
      10,
    );
  });

  it('preserves manually edited words instead of overwriting them', () => {
    const passA = singleWordDocument({
      id: 'doc-a',
      source: 'a',
      word: {
        id: 'word-1',
        text: 'HELL0',
        confidence: 0.5,
        box: [10, 10, 50, 16],
      },
    });
    const corrected = applyOCRCorrection(passA, {
      targetKind: 'word',
      targetId: 'word-1',
      text: 'HELLO!',
    });
    const passB = singleWordDocument({
      id: 'doc-b',
      source: 'b',
      word: {
        id: 'word-1',
        text: 'HELLO',
        confidence: 0.99,
        box: [10, 10, 50, 16],
      },
    });

    const merged = mergeOcrPasses(corrected, passB, {
      manualWordIds: ['word-1'],
    });
    const word = merged.blocks[0]?.lines[0]?.words[0];
    expect(word?.text).toBe('HELLO!');
    expect(word?.confidence).toBe(0.5);
    expect(merged.blocks[0]?.lines[0]?.text).toBe('HELLO!');
    expect(merged.reviewStatus).toBe('edited');
  });

  it('keeps words that only one pass read', () => {
    const passA = documentFrom({
      id: 'doc-a',
      source: 'a',
      confidence: 0.9,
      lines: [
        {
          id: 'line-1',
          text: 'LEFT',
          confidence: 0.9,
          words: [
            { id: 'word-a', text: 'LEFT', confidence: 0.9, box: [5, 5, 40, 14] },
          ],
        },
      ],
    });
    const passB = documentFrom({
      id: 'doc-b',
      source: 'b',
      confidence: 0.8,
      lines: [
        {
          id: 'line-1',
          text: 'RIGHT',
          confidence: 0.8,
          words: [
            {
              id: 'word-a',
              text: 'RIGHT',
              confidence: 0.8,
              box: [120, 5, 45, 14],
            },
          ],
        },
      ],
    });

    const merged = mergeOcrPasses(passA, passB);
    const words = merged.blocks.flatMap((block) =>
      block.lines.flatMap((line) => line.words),
    );
    expect(words.map((word) => word.text)).toEqual(['LEFT', 'RIGHT']);
    expect(words[1]?.id).toBe('word-a~1');
  });

  it('merges two empty documents into an empty document', () => {
    const merged = mergeOcrPasses(
      emptyDocument('doc-a', 'a', 0.4),
      emptyDocument('doc-b', 'b', 0.6),
    );
    expect(merged.blocks).toEqual([]);
    expect(merged.text).toBe('');
    expect(merged.confidence).toBe(0.6);
  });

  it('rejects passes from different image spaces and invalid options', () => {
    const passA = singleWordDocument({
      id: 'doc-a',
      source: 'a',
      word: {
        id: 'word-1',
        text: 'HELLO',
        confidence: 0.9,
        box: [10, 10, 50, 16],
      },
    });
    const otherSpace = createImageSpace('other-page', 200, 120);
    const foreign = parseOCRDocument(
      {
        id: 'doc-b',
        text: 'HELLO',
        boundingBox: fullPageBox(otherSpace),
        confidence: 0.9,
        coordinateSpace: otherSpace,
        blocks: [],
      },
      otherSpace,
      { source: 'b', version: '1', inputHashes: [hash('b')] },
    );
    expect(() => mergeOcrPasses(passA, foreign)).toThrow(OCRError);
    expect(() => mergeOcrPasses(passA, passA, { matchIouThreshold: 0 })).toThrow(
      OCRError,
    );
    expect(() =>
      mergeOcrPasses(passA, passA, { agreementConfidenceBoost: -0.1 }),
    ).toThrow(OCRError);
  });
});

describe('buildReviewQueue', () => {
  const mixedDocument = documentFrom({
    id: 'doc-mixed',
    source: 'm',
    confidence: 0.7,
    lines: [
      {
        id: 'line-1',
        text: 'KEEP',
        confidence: 0.92,
        words: [
          { id: 'word-1', text: 'KEEP', confidence: 0.91, box: [10, 10, 40, 14] },
        ],
      },
      {
        id: 'line-2',
        text: 'SHAKY',
        confidence: 0.5,
        words: [
          {
            id: 'word-2',
            text: 'SHAKY',
            confidence: 0.45,
            box: [10, 40, 45, 14],
          },
        ],
      },
      {
        id: 'line-3',
        text: 'SOSO',
        confidence: 0.72,
        words: [
          { id: 'word-3', text: 'SOSO', confidence: 0.7, box: [10, 70, 40, 14] },
        ],
      },
    ],
  });

  it('orders uncertain words and lines by ascending confidence', () => {
    const queue = buildReviewQueue(mixedDocument);
    expect(queue.map((item) => item.id)).toEqual([
      'word-2',
      'line-2',
      'word-3',
      'line-3',
    ]);
    expect(queue.map((item) => item.kind)).toEqual([
      'word',
      'line',
      'word',
      'line',
    ]);
    expect(queue.map((item) => item.confidence)).toEqual([0.45, 0.5, 0.7, 0.72]);
    expect(queue[0]?.text).toBe('SHAKY');
    expect(queue[0]?.boundingBox).toEqual(bounds(10, 40, 45, 14));
    expect(queue[0]?.reason).toBe('low-confidence');
    expect(queue[0]?.suggestedAlternatives).toEqual([]);
  });

  it('filters by the confidence threshold', () => {
    expect(buildReviewQueue(mixedDocument, { confidenceThreshold: 0.5 })).toEqual(
      [expect.objectContaining({ id: 'word-2' })],
    );
    const atThreshold = singleWordDocument({
      id: 'doc-a',
      source: 'a',
      word: {
        id: 'word-1',
        text: 'EXACT',
        confidence: 0.85,
        box: [10, 10, 40, 14],
      },
      lineConfidence: 0.9,
    });
    expect(buildReviewQueue(atThreshold)).toEqual([]);
    expect(buildReviewQueue(atThreshold, { confidenceThreshold: 0.86 })).toEqual([
      expect.objectContaining({ id: 'word-1' }),
    ]);
  });

  it('caps with maxItems unless includeAllBelow is set', () => {
    const lines: LineSpec[] = [];
    for (let index = 0; index < 5; index += 1) {
      const word: WordSpec = {
        id: `word-${index}`,
        text: `W${index}`,
        confidence: 0.1 + index * 0.1,
        box: [10, 5 + index * 20, 30, 12],
      };
      lines.push({
        id: `line-${index}`,
        text: word.text,
        confidence: word.confidence,
        words: [word],
      });
    }
    const document = documentFrom({
      id: 'doc-many',
      source: 'x',
      confidence: 0.3,
      lines,
    });
    const capped = buildReviewQueue(document, { maxItems: 2 });
    expect(capped.map((item) => item.id)).toEqual(['word-0', 'line-0']);
    const full = buildReviewQueue(document, {
      maxItems: 2,
      includeAllBelow: true,
    });
    expect(full).toHaveLength(10);
  });

  it('suggests alternative text from the other pass on disagreement', () => {
    const passA = singleWordDocument({
      id: 'doc-a',
      source: 'a',
      word: {
        id: 'word-1',
        text: 'HELL0',
        confidence: 0.4,
        box: [10, 10, 50, 16],
      },
      lineConfidence: 0.9,
    });
    const passB = singleWordDocument({
      id: 'doc-b',
      source: 'b',
      word: {
        id: 'word-1',
        text: 'HELLO',
        confidence: 0.7,
        box: [10, 10, 50, 16],
      },
      lineConfidence: 0.9,
    });

    const queue = buildReviewQueue(passA, { otherPass: passB });
    expect(queue).toEqual([
      expect.objectContaining({
        id: 'word-1',
        kind: 'word',
        suggestedAlternatives: ['HELLO'],
        reason: 'pass-disagreement',
      }),
    ]);

    const agreeing = buildReviewQueue(passA, {
      otherPass: singleWordDocument({
        id: 'doc-b',
        source: 'b',
        word: {
          id: 'word-1',
          text: 'HELL0',
          confidence: 0.7,
          box: [10, 10, 50, 16],
        },
        lineConfidence: 0.9,
      }),
    });
    expect(agreeing[0]?.reason).toBe('low-confidence');
    expect(agreeing[0]?.suggestedAlternatives).toEqual([]);
  });

  it('returns an empty queue for empty documents', () => {
    expect(buildReviewQueue(emptyDocument('doc-e', 'e', 0.2))).toEqual([]);
  });
});

describe('summarizeTriage', () => {
  it('reports word counts, queue pressure, and average confidence', () => {
    const document = documentFrom({
      id: 'doc-stats',
      source: 's',
      confidence: 0.6,
      lines: [
        {
          id: 'line-1',
          text: 'A B',
          confidence: 0.9,
          words: [
            { id: 'word-1', text: 'A', confidence: 0.2, box: [10, 10, 12, 12] },
            { id: 'word-2', text: 'B', confidence: 0.4, box: [30, 10, 12, 12] },
          ],
        },
        {
          id: 'line-2',
          text: 'C D',
          confidence: 0.9,
          words: [
            { id: 'word-3', text: 'C', confidence: 0.7, box: [10, 40, 12, 12] },
            { id: 'word-4', text: 'D', confidence: 0.9, box: [30, 40, 12, 12] },
          ],
        },
      ],
    });
    const queue = buildReviewQueue(document);
    expect(summarizeTriage(document, queue)).toEqual({
      totalWords: 4,
      uncertainCount: 3,
      reviewNeeded: true,
      averageConfidence: 0.55,
    });
  });

  it('summarizes empty documents without review pressure', () => {
    const document = emptyDocument('doc-e', 'e', 0.3);
    expect(summarizeTriage(document, [])).toEqual({
      totalWords: 0,
      uncertainCount: 0,
      reviewNeeded: false,
      averageConfidence: 1,
    });
  });
});
