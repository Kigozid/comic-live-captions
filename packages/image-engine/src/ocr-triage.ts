import type {
  Bounds,
  ImageSpace,
  OCRBlock,
  OCRDocument,
  OCRLine,
  OCRWord,
} from '@comic-captioner/shared';
import { freezeDocument, OCRError } from './ocr.js';

/**
 * Deterministic two-pass OCR triage.
 *
 * A second OCR pass over a differently preprocessed raster acts as an
 * independent vote on the same page geometry. Nodes are paired across passes
 * by bounding-box IoU; agreeing text raises confidence, disagreeing text keeps
 * the higher-confidence reading at a reduced confidence so the review queue
 * surfaces it. Manual corrections in the primary pass always win.
 */

export const DEFAULT_MATCH_IOU_THRESHOLD = 0.5;
export const DEFAULT_AGREEMENT_CONFIDENCE_BOOST = 0.1;
export const DEFAULT_DISAGREEMENT_CONFIDENCE_PENALTY = 0.2;
export const DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.85;

export interface MergeOcrPassesOptions {
  /** Minimum bounding-box IoU for pairing nodes across passes. Default 0.5. */
  readonly matchIouThreshold?: number;
  /** Confidence added when both passes read the same text. Default 0.1. */
  readonly agreementConfidenceBoost?: number;
  /** Confidence subtracted when passes disagree on text. Default 0.2. */
  readonly disagreementConfidencePenalty?: number;
  /**
   * Word IDs corrected by a human in `passA`. Their text and confidence are
   * carried through the merge untouched.
   */
  readonly manualWordIds?: Iterable<string>;
}

export type OcrReviewItemKind = 'word' | 'line';

export type OcrReviewReason = 'low-confidence' | 'pass-disagreement';

export interface OcrReviewItem {
  readonly id: string;
  readonly kind: OcrReviewItemKind;
  readonly text: string;
  readonly confidence: number;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly suggestedAlternatives: readonly string[];
  readonly reason: OcrReviewReason;
}

export interface OcrReviewQueueOptions {
  /** Items strictly below this confidence are queued. Default 0.85. */
  readonly confidenceThreshold?: number;
  /** Truncate the queue to this many items unless `includeAllBelow` is set. */
  readonly maxItems?: number;
  /** Return every below-threshold item even when `maxItems` is set. */
  readonly includeAllBelow?: boolean;
  /** Second pass used to propose alternative texts for disagreeing items. */
  readonly otherPass?: OCRDocument;
  /** IoU for pairing queue items with `otherPass` nodes. Default 0.5. */
  readonly matchIouThreshold?: number;
}

export interface OcrTriageSummary {
  /** Words in the document, across every line and block. */
  readonly totalWords: number;
  /** Word-kind review items (uncertain words) in the queue. */
  readonly uncertainCount: number;
  /** True when the queue holds at least one item. */
  readonly reviewNeeded: boolean;
  /** Mean word confidence across the document; 1 when there are no words. */
  readonly averageConfidence: number;
}

/** Merge a secondary OCR pass into the primary document as independent votes. */
export function mergeOcrPasses(
  passA: OCRDocument,
  passB: OCRDocument,
  options: MergeOcrPassesOptions = {},
): OCRDocument {
  const matchIouThreshold = requireIouThreshold(
    options.matchIouThreshold ?? DEFAULT_MATCH_IOU_THRESHOLD,
    'matchIouThreshold',
  );
  const agreementBoost = requireNonNegative(
    options.agreementConfidenceBoost ?? DEFAULT_AGREEMENT_CONFIDENCE_BOOST,
    'agreementConfidenceBoost',
  );
  const disagreementPenalty = requireNonNegative(
    options.disagreementConfidencePenalty ??
      DEFAULT_DISAGREEMENT_CONFIDENCE_PENALTY,
    'disagreementConfidencePenalty',
  );
  const manualWordIds = new Set(options.manualWordIds ?? []);
  if (passA.coordinateSpace.id !== passB.coordinateSpace.id)
    throw new OCRError(
      `OCR passes must share one image space; got ${passA.coordinateSpace.id} and ${passB.coordinateSpace.id}.`,
    );

  const vote = (
    a: { text: string; confidence: number },
    b: { text: string; confidence: number },
  ): { text: string; confidence: number } => {
    const agree = comparisonKey(a.text) === comparisonKey(b.text);
    const winner = a.confidence >= b.confidence ? a : b;
    return {
      text: winner.text,
      confidence: clamp01(
        winner.confidence +
          (agree
            ? agreementBoost
            : -disagreementPenalty),
      ),
    };
  };

  const usedIds = new Set<string>();
  const claimId = (preferred: string): string => {
    let id = preferred;
    let suffix = 0;
    while (usedIds.has(id)) {
      suffix += 1;
      id = `${preferred}~${suffix}`;
    }
    usedIds.add(id);
    return id;
  };
  for (const block of passA.blocks) {
    claimId(block.id);
    for (const line of block.lines) {
      claimId(line.id);
      for (const word of line.words) claimId(word.id);
    }
  }

  const mergeWords = (
    wordsA: readonly OCRWord[],
    wordsB: readonly OCRWord[],
  ): OCRWord[] => {
    const pairs = greedyIouPairs(
      wordsA.length,
      wordsB.length,
      (index) => wordsA[index]!.boundingBox,
      (index) => wordsB[index]!.boundingBox,
      matchIouThreshold,
    );
    const matchedB = new Set(pairs.map((pair) => pair[1]));
    const merged: OCRWord[] = [];
    const matchedByA = new Map(pairs.map((pair) => [pair[0], pair[1]]));
    for (let index = 0; index < wordsA.length; index += 1) {
      const wordA = wordsA[index]!;
      const partner = matchedByA.get(index);
      if (partner === undefined) {
        merged.push(wordA);
        continue;
      }
      const wordB = wordsB[partner]!;
      if (manualWordIds.has(wordA.id)) {
        merged.push(wordA);
        continue;
      }
      const voted = vote(wordA, wordB);
      merged.push({ ...wordA, text: voted.text, confidence: voted.confidence });
      usedIds.add(wordA.id);
    }
    for (let index = 0; index < wordsB.length; index += 1) {
      if (matchedB.has(index)) continue;
      const wordB = wordsB[index]!;
      merged.push({ ...wordB, id: claimId(wordB.id) });
    }
    return merged;
  };

  const mergeLines = (
    lineA: OCRLine,
    lineB: OCRLine | undefined,
  ): OCRLine => {
    if (!lineB) return lineA;
    const words = mergeWords(lineA.words, lineB.words);
    const wordsChanged = !sameTexts(
      words.map((word) => word.text),
      lineA.words.map((word) => word.text),
    );
    return {
      ...lineA,
      text: wordsChanged ? words.map((word) => word.text).join(' ') : lineA.text,
      confidence: words.length
        ? mean(words.map((word) => word.confidence))
        : vote(lineA, lineB).confidence,
      words,
    };
  };

  const mergeBlock = (blockA: OCRBlock, blockB: OCRBlock | undefined): OCRBlock => {
    if (!blockB) return blockA;
    const pairs = greedyIouPairs(
      blockA.lines.length,
      blockB.lines.length,
      (index) => blockA.lines[index]!.boundingBox,
      (index) => blockB.lines[index]!.boundingBox,
      matchIouThreshold,
    );
    const matchedByA = new Map(pairs.map((pair) => [pair[0], pair[1]]));
    const matchedB = new Set(pairs.map((pair) => pair[1]));
    const lines: OCRLine[] = [];
    for (let index = 0; index < blockA.lines.length; index += 1) {
      const partner = matchedByA.get(index);
      lines.push(
        mergeLines(
          blockA.lines[index]!,
          partner === undefined ? undefined : blockB.lines[partner],
        ),
      );
    }
    for (let index = 0; index < blockB.lines.length; index += 1) {
      if (matchedB.has(index)) continue;
      const lineB = blockB.lines[index]!;
      const words = lineB.words.map((word) => ({ ...word, id: claimId(word.id) }));
      lines.push({ ...lineB, id: claimId(lineB.id), words });
    }
    const linesChanged = !sameTexts(
      lines.map((line) => line.text),
      blockA.lines.map((line) => line.text),
    );
    return {
      ...blockA,
      text: linesChanged ? lines.map((line) => line.text).join('\n') : blockA.text,
      confidence: lines.length
        ? mean(lines.map((line) => line.confidence))
        : vote(blockA, blockB).confidence,
      lines,
    };
  };

  const blockPairs = greedyIouPairs(
    passA.blocks.length,
    passB.blocks.length,
    (index) => passA.blocks[index]!.boundingBox,
    (index) => passB.blocks[index]!.boundingBox,
    matchIouThreshold,
  );
  const matchedBBlocks = new Set(blockPairs.map((pair) => pair[1]));
  const matchedByA = new Map(blockPairs.map((pair) => [pair[0], pair[1]]));
  const blocks: OCRBlock[] = [];
  for (let index = 0; index < passA.blocks.length; index += 1) {
    blocks.push(
      mergeBlock(
        passA.blocks[index]!,
        matchedByA.has(index) ? passB.blocks[matchedByA.get(index)!] : undefined,
      ),
    );
  }
  for (let index = 0; index < passB.blocks.length; index += 1) {
    if (matchedBBlocks.has(index)) continue;
    const blockB = passB.blocks[index]!;
    const lines = blockB.lines.map((line) => ({
      ...line,
      id: claimId(line.id),
      words: line.words.map((word) => ({ ...word, id: claimId(word.id) })),
    }));
    blocks.push({ ...blockB, id: claimId(blockB.id), lines });
  }

  const blocksChanged = !sameTexts(
    blocks.map((block) => block.text),
    passA.blocks.map((block) => block.text),
  );
  const provenanceHashes = [
    ...passA.provenance.inputHashes,
    ...passB.provenance.inputHashes.filter(
      (hash) => !passA.provenance.inputHashes.includes(hash),
    ),
  ];
  return freezeDocument({
    ...passA,
    text: blocksChanged ? blocks.map((block) => block.text).join('\n\n') : passA.text,
    confidence: blocks.length
      ? mean(blocks.map((block) => block.confidence))
      : Math.max(passA.confidence, passB.confidence),
    blocks,
    reviewStatus:
      passA.reviewStatus === 'edited' || manualWordIds.size > 0
        ? 'edited'
        : 'pending-review',
    provenance: {
      source: `${passA.provenance.source}+${passB.provenance.source}`,
      version: `${passA.provenance.version}+${passB.provenance.version}`,
      inputHashes: provenanceHashes,
    },
  });
}

/**
 * Prioritized uncertain words and lines: everything strictly below the
 * confidence threshold, lowest confidence first. `otherPass` contributes
 * suggested alternative texts when its paired node read something else.
 */
export function buildReviewQueue(
  document: OCRDocument,
  options: OcrReviewQueueOptions = {},
): OcrReviewItem[] {
  const threshold = requireConfidenceThreshold(
    options.confidenceThreshold ?? DEFAULT_REVIEW_CONFIDENCE_THRESHOLD,
    'confidenceThreshold',
  );
  const matchIouThreshold = requireIouThreshold(
    options.matchIouThreshold ?? DEFAULT_MATCH_IOU_THRESHOLD,
    'matchIouThreshold',
  );
  if (options.maxItems !== undefined) {
    if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 0)
      throw new OCRError('maxItems must be a non-negative integer.');
  }

  const words = collectWords(document);
  const lines = collectLines(document);
  const alternatives = options.otherPass
    ? collectAlternatives(document, options.otherPass, matchIouThreshold)
    : new Map<string, string>();

  const candidates: { item: OcrReviewItem; order: number }[] = [];
  let order = 0;
  for (const entry of words) {
    if (entry.node.confidence >= threshold) continue;
    const alternative = alternatives.get(entry.node.id);
    candidates.push({
      order,
      item: {
        id: entry.node.id,
        kind: 'word',
        text: entry.node.text,
        confidence: entry.node.confidence,
        boundingBox: entry.node.boundingBox,
        suggestedAlternatives: alternative !== undefined ? [alternative] : [],
        reason: alternative !== undefined ? 'pass-disagreement' : 'low-confidence',
      },
    });
    order += 1;
  }
  for (const entry of lines) {
    if (entry.node.confidence >= threshold) continue;
    const alternative = alternatives.get(entry.node.id);
    candidates.push({
      order,
      item: {
        id: entry.node.id,
        kind: 'line',
        text: entry.node.text,
        confidence: entry.node.confidence,
        boundingBox: entry.node.boundingBox,
        suggestedAlternatives: alternative !== undefined ? [alternative] : [],
        reason: alternative !== undefined ? 'pass-disagreement' : 'low-confidence',
      },
    });
    order += 1;
  }
  candidates.sort(
    (a, b) => a.item.confidence - b.item.confidence || a.order - b.order,
  );
  const queue = candidates.map((entry) => entry.item);
  if (options.includeAllBelow || options.maxItems === undefined) return queue;
  return queue.slice(0, options.maxItems);
}

/** Queue and document statistics for the review UI. */
export function summarizeTriage(
  document: OCRDocument,
  queue: readonly OcrReviewItem[],
): OcrTriageSummary {
  const words = collectWords(document);
  return {
    totalWords: words.length,
    uncertainCount: queue.filter((item) => item.kind === 'word').length,
    reviewNeeded: queue.length > 0,
    averageConfidence: words.length
      ? mean(words.map((entry) => entry.node.confidence))
      : 1,
  };
}

interface NodeEntry<T> {
  readonly node: T;
  readonly boundingBox: Bounds<ImageSpace>;
}

function collectWords(document: OCRDocument): NodeEntry<OCRWord>[] {
  const entries: NodeEntry<OCRWord>[] = [];
  for (const block of document.blocks)
    for (const line of block.lines)
      for (const word of line.words)
        entries.push({ node: word, boundingBox: word.boundingBox });
  return entries;
}

function collectLines(document: OCRDocument): NodeEntry<OCRLine>[] {
  const entries: NodeEntry<OCRLine>[] = [];
  for (const block of document.blocks)
    for (const line of block.lines)
      entries.push({ node: line, boundingBox: line.boundingBox });
  return entries;
}

function collectAlternatives(
  document: OCRDocument,
  otherPass: OCRDocument,
  matchIouThreshold: number,
): Map<string, string> {
  const alternatives = new Map<string, string>();
  const pairTexts = <T extends { id: string; text: string }>(
    local: NodeEntry<T>[],
    remote: NodeEntry<T>[],
  ) => {
    const pairs = greedyIouPairs(
      local.length,
      remote.length,
      (index) => local[index]!.boundingBox,
      (index) => remote[index]!.boundingBox,
      matchIouThreshold,
    );
    for (const [localIndex, remoteIndex] of pairs) {
      const localNode = local[localIndex]!.node;
      const remoteNode = remote[remoteIndex]!.node;
      if (comparisonKey(localNode.text) === comparisonKey(remoteNode.text))
        continue;
      if (!alternatives.has(localNode.id))
        alternatives.set(localNode.id, remoteNode.text);
    }
  };
  pairTexts(collectWords(document), collectWords(otherPass));
  pairTexts(collectLines(document), collectLines(otherPass));
  return alternatives;
}

function greedyIouPairs(
  countA: number,
  countB: number,
  boxOfA: (index: number) => Bounds<ImageSpace>,
  boxOfB: (index: number) => Bounds<ImageSpace>,
  threshold: number,
): (readonly [number, number])[] {
  const candidates: { a: number; b: number; iou: number }[] = [];
  for (let a = 0; a < countA; a += 1)
    for (let b = 0; b < countB; b += 1) {
      const iou = boundsIou(boxOfA(a), boxOfB(b));
      if (iou >= threshold) candidates.push({ a, b, iou });
    }
  candidates.sort((x, y) => y.iou - x.iou || x.a - y.a || x.b - y.b);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: (readonly [number, number])[] = [];
  for (const candidate of candidates) {
    if (usedA.has(candidate.a) || usedB.has(candidate.b)) continue;
    usedA.add(candidate.a);
    usedB.add(candidate.b);
    pairs.push([candidate.a, candidate.b]);
  }
  return pairs;
}

function boundsIou(a: Bounds<ImageSpace>, b: Bounds<ImageSpace>): number {
  const overlapWidth =
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapHeight =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  const intersection = overlapWidth * overlapHeight;
  return (
    intersection / (a.width * a.height + b.width * b.height - intersection)
  );
}

function comparisonKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameTexts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((text, index) => text === b[index]);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function requireIouThreshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1)
    throw new OCRError(`${label} must be in (0, 1].`);
  return value;
}

function requireConfidenceThreshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new OCRError(`${label} must be in [0, 1].`);
  return value;
}

function requireNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new OCRError(`${label} must be finite and non-negative.`);
  return value;
}
