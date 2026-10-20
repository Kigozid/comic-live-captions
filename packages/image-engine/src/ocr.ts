import { createHash } from 'node:crypto';
import type {
  Bounds,
  ImageSpace,
  OCRBlock,
  OCRCorrection,
  OCRDocument,
  OCRLine,
  OCRWord,
  Provenance,
} from '@comic-captioner/shared';

export interface OCRInput {
  /** Original encoded image bytes. Providers must not retain or mutate them. */
  readonly image: Uint8Array;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly coordinateSpace: ImageSpace;
}

/** Adapter boundary: raw provider response is validated before entering the domain. */
export interface OCRProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  recognize(input: OCRInput): Promise<unknown>;
}

export interface OCRService {
  recognize(input: OCRInput): Promise<OCRDocument>;
}

export class OCRError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OCRError';
  }
}

/** A provider can be swapped without changing the OCR domain contract. */
export class ValidatingOCRService implements OCRService {
  constructor(private readonly provider: OCRProvider) {}

  async recognize(input: OCRInput): Promise<OCRDocument> {
    const raw = await this.provider.recognize({
      ...input,
      image: Uint8Array.from(input.image),
    });
    return parseOCRDocument(raw, input.coordinateSpace, {
      source: this.provider.providerId,
      version: this.provider.providerVersion,
      inputHashes: [createHash('sha256').update(input.image).digest('hex')],
    });
  }
}

/** Validate and freeze provider output at the trust boundary. */
export function parseOCRDocument(
  value: unknown,
  expectedSpace: ImageSpace,
  provenance: Provenance,
): OCRDocument {
  const checkedProvenance = parseProvenance(provenance);
  const ids = new Set<string>();
  const document = parseDocument(value, expectedSpace, ids, checkedProvenance);
  return freezeDocument(document);
}

/** Apply one user edit immutably. The result is a new editable revision. */
export function applyOCRCorrection(
  document: OCRDocument,
  correction: OCRCorrection,
): OCRDocument {
  if (!correction.targetId.trim()) throw new OCRError('Target ID is required.');
  const targetSpace = findNodeSpace(document, correction);
  if (!targetSpace) throw new OCRError('OCR correction target was not found.');
  if (correction.text !== undefined && typeof correction.text !== 'string') {
    throw new OCRError('Corrected text must be a string.');
  }
  const boundingBox = correction.boundingBox
    ? parseBounds(correction.boundingBox, targetSpace)
    : undefined;
  let changed = false;

  function correctWord(word: OCRWord): OCRWord {
    if (correction.targetKind !== 'word' || word.id !== correction.targetId)
      return word;
    changed = true;
    return {
      ...word,
      ...(correction.text !== undefined ? { text: correction.text } : {}),
      ...(boundingBox ? { boundingBox } : {}),
    };
  }

  function correctLine(line: OCRLine): OCRLine {
    const words = line.words.map(correctWord);
    const self =
      correction.targetKind === 'line' && line.id === correction.targetId;
    if (self) changed = true;
    return {
      ...line,
      ...(self && correction.text !== undefined
        ? { text: correction.text }
        : words.some((word, index) => word !== line.words[index])
          ? { text: words.map((word) => word.text).join(' ') }
          : {}),
      ...(self && boundingBox ? { boundingBox } : {}),
      words,
    };
  }

  function correctBlock(block: OCRBlock): OCRBlock {
    const lines = block.lines.map(correctLine);
    const self =
      correction.targetKind === 'block' && block.id === correction.targetId;
    if (self) changed = true;
    return {
      ...block,
      ...(self && correction.text !== undefined
        ? { text: correction.text }
        : lines.some((line, index) => line !== block.lines[index])
          ? { text: lines.map((line) => line.text).join('\n') }
          : {}),
      ...(self && boundingBox ? { boundingBox } : {}),
      lines,
    };
  }

  const blocks = document.blocks.map(correctBlock);
  const isDocument =
    correction.targetKind === 'document' && document.id === correction.targetId;
  if (isDocument) changed = true;
  if (!changed) throw new OCRError('OCR correction target was not found.');
  const result: OCRDocument = {
    ...document,
    ...(isDocument && correction.text !== undefined
      ? { text: correction.text }
      : blocks.some((block, index) => block !== document.blocks[index])
        ? { text: blocks.map((block) => block.text).join('\n\n') }
        : {}),
    ...(isDocument && boundingBox ? { boundingBox } : {}),
    blocks,
    revision: document.revision + 1,
    reviewStatus: 'edited',
  };
  return freezeDocument(result);
}

function parseDocument(
  value: unknown,
  space: ImageSpace,
  ids: Set<string>,
  provenance: Provenance,
): OCRDocument {
  const record = asRecord(value, 'OCR document');
  const blocks = asArray(record.blocks, 'OCR document blocks').map((block) =>
    parseBlock(block, space, ids),
  );
  return {
    id: parseId(record.id, ids),
    text: parseText(record.text),
    boundingBox: parseBounds(record.boundingBox, space),
    confidence: parseConfidence(record.confidence),
    coordinateSpace: parseSpace(record.coordinateSpace, space),
    blocks,
    revision: 1,
    reviewStatus: 'pending-review',
    provenance: Object.freeze({
      source: provenance.source,
      version: provenance.version,
      inputHashes: Object.freeze([...provenance.inputHashes]),
    }),
  };
}

function parseBlock(
  value: unknown,
  space: ImageSpace,
  ids: Set<string>,
): OCRBlock {
  const record = asRecord(value, 'OCR block');
  return {
    id: parseId(record.id, ids),
    text: parseText(record.text),
    boundingBox: parseBounds(record.boundingBox, space),
    confidence: parseConfidence(record.confidence),
    coordinateSpace: parseSpace(record.coordinateSpace, space),
    lines: asArray(record.lines, 'OCR block lines').map((line) =>
      parseLine(line, space, ids),
    ),
  };
}

function parseLine(
  value: unknown,
  space: ImageSpace,
  ids: Set<string>,
): OCRLine {
  const record = asRecord(value, 'OCR line');
  return {
    id: parseId(record.id, ids),
    text: parseText(record.text),
    boundingBox: parseBounds(record.boundingBox, space),
    confidence: parseConfidence(record.confidence),
    coordinateSpace: parseSpace(record.coordinateSpace, space),
    words: asArray(record.words, 'OCR line words').map((word) =>
      parseWord(word, space, ids),
    ),
  };
}

function parseWord(
  value: unknown,
  space: ImageSpace,
  ids: Set<string>,
): OCRWord {
  const record = asRecord(value, 'OCR word');
  return {
    id: parseId(record.id, ids),
    text: parseText(record.text),
    boundingBox: parseBounds(record.boundingBox, space),
    confidence: parseConfidence(record.confidence),
    coordinateSpace: parseSpace(record.coordinateSpace, space),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OCRError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new OCRError(`${label} must be an array.`);
  return value;
}

function parseId(value: unknown, ids: Set<string>): string {
  if (typeof value !== 'string' || !value.trim())
    throw new OCRError('OCR IDs must be non-empty strings.');
  if (ids.has(value)) throw new OCRError(`Duplicate OCR ID: ${value}.`);
  ids.add(value);
  return value;
}

function parseText(value: unknown): string {
  if (typeof value !== 'string')
    throw new OCRError('OCR text must be a string.');
  return value;
}

function parseConfidence(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new OCRError('OCR confidence must be between 0 and 1.');
  return value;
}

function parseProvenance(value: unknown): Provenance {
  const provenance = asRecord(value, 'OCR provenance');
  if (
    typeof provenance.source !== 'string' ||
    !provenance.source.trim() ||
    typeof provenance.version !== 'string' ||
    !provenance.version.trim() ||
    !Array.isArray(provenance.inputHashes) ||
    provenance.inputHashes.some(
      (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash),
    )
  ) {
    throw new OCRError(
      'OCR provenance must include provider, version, and SHA-256 input hashes.',
    );
  }
  return {
    source: provenance.source,
    version: provenance.version,
    inputHashes: provenance.inputHashes,
  };
}

function parseSpace(value: unknown, expected: ImageSpace): ImageSpace {
  const space = asRecord(value, 'OCR coordinateSpace');
  if (space.kind !== 'image')
    throw new OCRError(`OCR geometry must use image space ${expected.id}.`);
  // Same page under a different id (workspace:… vs image:…) is retargeted
  // when dimensions match — alignment rewrites space ids after import.
  const dims = asRecord(space.dimensions, 'OCR coordinateSpace dimensions');
  const samePage =
    Number(dims.width) === expected.dimensions.width &&
    Number(dims.height) === expected.dimensions.height;
  if (space.id !== expected.id && !samePage)
    throw new OCRError(`OCR geometry must use image space ${expected.id}.`);
  return expected;
}

function parseBounds(value: unknown, space: ImageSpace): Bounds<ImageSpace> {
  const bounds = asRecord(value, 'OCR boundingBox');
  if (bounds.coordinateSpace !== undefined)
    parseSpace(bounds.coordinateSpace, space);
  const { x, y, width, height } = bounds;
  if (
    [x, y, width, height].some(
      (part) => typeof part !== 'number' || !Number.isFinite(part),
    ) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (x as number) < -0.5 ||
    (y as number) < -0.5 ||
    (x as number) + (width as number) > space.dimensions.width - 0.5 ||
    (y as number) + (height as number) > space.dimensions.height - 0.5
  ) {
    throw new OCRError(
      'OCR boundingBox must be a finite, positive box inside its image space.',
    );
  }
  return Object.freeze({
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
    coordinateSpace: space,
  });
}

function findNodeSpace(
  document: OCRDocument,
  correction: OCRCorrection,
): ImageSpace | null {
  if (
    correction.targetKind === 'document' &&
    document.id === correction.targetId
  )
    return document.coordinateSpace;
  for (const block of document.blocks) {
    if (correction.targetKind === 'block' && block.id === correction.targetId)
      return block.coordinateSpace;
    for (const line of block.lines) {
      if (correction.targetKind === 'line' && line.id === correction.targetId)
        return line.coordinateSpace;
      if (correction.targetKind === 'word') {
        const word = line.words.find(
          (entry) => entry.id === correction.targetId,
        );
        if (word) return word.coordinateSpace;
      }
    }
  }
  return null;
}

export function freezeDocument(document: OCRDocument): OCRDocument {
  const blocks = document.blocks.map((block) =>
    Object.freeze({
      ...block,
      boundingBox: Object.freeze({ ...block.boundingBox }),
      lines: Object.freeze(
        block.lines.map((line) =>
          Object.freeze({
            ...line,
            boundingBox: Object.freeze({ ...line.boundingBox }),
            words: Object.freeze(
              line.words.map((word) =>
                Object.freeze({
                  ...word,
                  boundingBox: Object.freeze({ ...word.boundingBox }),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  );
  return Object.freeze({
    ...document,
    boundingBox: Object.freeze({ ...document.boundingBox }),
    blocks: Object.freeze(blocks),
  });
}
