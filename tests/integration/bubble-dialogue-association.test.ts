import { describe, expect, it, vi } from 'vitest';
import { correctBubbleDialogueReference } from '@comic-captioner/core';
import {
  createMaskSpace,
  createImageSpace,
  type AlignmentResult,
  type Bounds,
  type ImageSpace,
  type OCRDocument,
  type OCRLine,
  type OriginalTextRegion,
  type Point,
  type Polygon,
} from '@comic-captioner/shared';
import {
  BubbleDialogueAssociationEngine,
  createManualBubble,
  type Bubble,
} from '@comic-captioner/bubble-engine';

const engine = new BubbleDialogueAssociationEngine();
const originalSpace = createImageSpace('original-page', 240, 180);

function polygon(
  space: ImageSpace,
  box: Pick<Bounds<ImageSpace>, 'x' | 'y' | 'width' | 'height'>,
): Polygon<ImageSpace> {
  const points: Point<ImageSpace>[] = [
    { x: box.x, y: box.y, coordinateSpace: space },
    { x: box.x + box.width, y: box.y, coordinateSpace: space },
    { x: box.x + box.width, y: box.y + box.height, coordinateSpace: space },
    { x: box.x, y: box.y + box.height, coordinateSpace: space },
  ];
  return { points, coordinateSpace: space };
}

function bubble(
  id: string,
  space: ImageSpace,
  box: Pick<Bounds<ImageSpace>, 'x' | 'y' | 'width' | 'height'>,
): Bubble {
  return createManualBubble({
    id,
    coordinateSpace: space,
    polygon: polygon(space, box),
    kind: 'speech',
    shape: 'rounded-rectangle',
  });
}

function originalTextRegion(
  id: string,
  space: ImageSpace,
  box: Pick<Bounds<ImageSpace>, 'x' | 'y' | 'width' | 'height'>,
): OriginalTextRegion {
  const bounds: Bounds<ImageSpace> = { ...box, coordinateSpace: space };
  const maskSpace = createMaskSpace(
    `region-mask-${id}`,
    space,
    space.dimensions.width,
    space.dimensions.height,
  );
  return {
    id,
    mask: {
      width: 1,
      height: 1,
      runs: [{ x: 0, y: 0, length: 1 }],
      origin: {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        coordinateSpace: maskSpace,
      },
      coordinateSpace: maskSpace,
    },
    polygon: polygon(space, box),
    boundingBox: bounds,
    confidence: 0.84,
    coordinateSpace: space,
  };
}

function ocrDocument(
  space: ImageSpace,
  entries: readonly {
    id: string;
    text: string;
    box: Pick<Bounds<ImageSpace>, 'x' | 'y' | 'width' | 'height'>;
  }[],
): OCRDocument {
  const lines: OCRLine[] = entries.map(({ id, text, box }) => ({
    id,
    text,
    boundingBox: { ...box, coordinateSpace: space },
    confidence: 0.93,
    coordinateSpace: space,
    words: [],
  }));
  const left = Math.min(...entries.map(({ box }) => box.x));
  const top = Math.min(...entries.map(({ box }) => box.y));
  const right = Math.max(...entries.map(({ box }) => box.x + box.width));
  const bottom = Math.max(...entries.map(({ box }) => box.y + box.height));
  const boundingBox = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: space,
  };
  const text = lines.map((line) => line.text).join('\n');
  return {
    id: 'fixture-ocr',
    text,
    boundingBox,
    confidence: 0.93,
    coordinateSpace: space,
    blocks: [
      {
        id: 'block-1',
        text,
        boundingBox,
        confidence: 0.93,
        coordinateSpace: space,
        lines,
      },
    ],
    revision: 1,
    reviewStatus: 'pending-review',
    provenance: {
      source: 'fixture',
      version: '1',
      inputHashes: ['a'.repeat(64)],
    },
  };
}

describe('BubbleDialogueAssociationEngine integration', () => {
  it('associates original OCR lines and removed-text regions to the spatially containing bubble', async () => {
    const bubbleGeometry = bubble('bubble-1', originalSpace, {
      x: 30,
      y: 25,
      width: 120,
      height: 100,
    });
    const region = originalTextRegion('region-1', originalSpace, {
      x: 65,
      y: 58,
      width: 50,
      height: 18,
    });
    const result = await engine.associate({
      bubbles: [bubbleGeometry],
      originalTextRegions: [region],
      ocrDocument: ocrDocument(originalSpace, [
        { id: 'line-1', text: 'WAIT FOR ME!', box: region.boundingBox },
      ]),
      coordinateSpace: originalSpace,
    });

    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({
      bubbleId: 'bubble-1',
      textRegionIds: ['region-1'],
      originalText: 'WAIT FOR ME!',
      lineCount: 1,
      alignment: 'center',
      method: 'spatial',
      status: 'pending-review',
    });
    expect(result.references[0]?.originalTextBounds.coordinateSpace.id).toBe(
      originalSpace.id,
    );
    expect(result.references[0]?.confidence).toBeGreaterThan(0.75);
    expect(result.unassignedTextRegionIds).toEqual([]);
  });

  it('maps cleaned-page bubble geometry through the alignment transform into original page space', async () => {
    const cleanedSpace = createImageSpace('clean-page', 120, 90);
    const alignedBubble = bubble('bubble-aligned', cleanedSpace, {
      x: 15,
      y: 12,
      width: 45,
      height: 40,
    });
    const alignment: AlignmentResult = {
      sourceSpace: cleanedSpace,
      targetSpace: originalSpace,
      scale: 2,
      rotation: 0,
      translation: { x: 20, y: 10, coordinateSpace: originalSpace },
      confidence: 0.98,
      transformMatrix: { values: [2, 0, 20, 0, 2, 10] },
      method: 'manual',
      algorithmVersion: 'fixture',
    };
    const region = originalTextRegion('region-aligned', originalSpace, {
      x: 65,
      y: 50,
      width: 40,
      height: 20,
    });
    const result = await engine.associate({
      bubbles: [alignedBubble],
      originalTextRegions: [region],
      ocrDocument: ocrDocument(originalSpace, [
        { id: 'line-a', text: 'GO!', box: region.boundingBox },
      ]),
      coordinateSpace: originalSpace,
      alignment,
    });

    expect(result.references[0]?.bubbleId).toBe('bubble-aligned');
    expect(result.references[0]?.originalTextBounds.coordinateSpace.id).toBe(
      originalSpace.id,
    );
  });

  it('calls semantic resolution only for spatially ambiguous candidates', async () => {
    const first = bubble('bubble-a', originalSpace, {
      x: 30,
      y: 25,
      width: 120,
      height: 100,
    });
    const second = bubble('bubble-b', originalSpace, {
      x: 30,
      y: 25,
      width: 120,
      height: 100,
    });
    const region = originalTextRegion('region-ambiguous', originalSpace, {
      x: 65,
      y: 58,
      width: 50,
      height: 18,
    });
    const resolveAmbiguousBubble = vi.fn(async () => ({
      bubbleId: 'bubble-b',
      confidence: 0.88,
    }));
    const result = await engine.associate(
      {
        bubbles: [first, second],
        originalTextRegions: [region],
        ocrDocument: ocrDocument(originalSpace, [
          {
            id: 'line-ambiguous',
            text: 'I remember you.',
            box: region.boundingBox,
          },
        ]),
        coordinateSpace: originalSpace,
      },
      { semanticResolver: { resolveAmbiguousBubble } },
    );

    expect(resolveAmbiguousBubble).toHaveBeenCalledTimes(1);
    expect(resolveAmbiguousBubble).toHaveBeenCalledWith(
      expect.objectContaining({ originalText: 'I remember you.' }),
    );
    expect(result.references[0]?.bubbleId).toBe('bubble-b');
    expect(result.references[0]?.method).toBe('semantic');
    expect(result.ambiguousTextRegionIds).toEqual([]);

    const unambiguousResolver = vi.fn(async () => null);
    await engine.associate(
      {
        bubbles: [first],
        originalTextRegions: [region],
        ocrDocument: ocrDocument(originalSpace, [
          { id: 'line-clear', text: 'clear', box: region.boundingBox },
        ]),
        coordinateSpace: originalSpace,
      },
      { semanticResolver: { resolveAmbiguousBubble: unambiguousResolver } },
    );
    expect(unambiguousResolver).not.toHaveBeenCalled();
  });

  it('leaves uncontained regions unassigned and validates resolver proposals', async () => {
    const oneBubble = bubble('bubble-only', originalSpace, {
      x: 10,
      y: 10,
      width: 50,
      height: 45,
    });
    const outside = originalTextRegion('outside', originalSpace, {
      x: 175,
      y: 125,
      width: 30,
      height: 15,
    });
    const result = await engine.associate({
      bubbles: [oneBubble],
      originalTextRegions: [outside],
      ocrDocument: ocrDocument(originalSpace, [
        { id: 'line-outside', text: 'outside', box: outside.boundingBox },
      ]),
      coordinateSpace: originalSpace,
    });
    expect(result.unassignedTextRegionIds).toEqual(['outside']);
    expect(result.references).toEqual([]);

    const overlapOne = bubble('overlap-1', originalSpace, {
      x: 30,
      y: 25,
      width: 120,
      height: 100,
    });
    const overlapTwo = bubble('overlap-2', originalSpace, {
      x: 30,
      y: 25,
      width: 120,
      height: 100,
    });
    const region = originalTextRegion(
      'region-invalid-resolution',
      originalSpace,
      { x: 65, y: 58, width: 50, height: 18 },
    );
    await expect(
      engine.associate(
        {
          bubbles: [overlapOne, overlapTwo],
          originalTextRegions: [region],
          ocrDocument: ocrDocument(originalSpace, [
            { id: 'line-invalid', text: 'ambiguous', box: region.boundingBox },
          ]),
          coordinateSpace: originalSpace,
        },
        {
          semanticResolver: {
            resolveAmbiguousBubble: async () => ({
              bubbleId: 'not-a-candidate',
              confidence: 0.9,
            }),
          },
        },
      ),
    ).rejects.toThrow(/outside the spatial candidate/);
  });

  it('accepts a manual correction only when bubble, regions, and image geometry validate', async () => {
    const bubbleGeometry = bubble('bubble-manual', originalSpace, {
      x: 30,
      y: 25,
      width: 120,
      height: 100,
    });
    const region = originalTextRegion('region-manual', originalSpace, {
      x: 65,
      y: 58,
      width: 50,
      height: 18,
    });
    const result = await engine.associate({
      bubbles: [bubbleGeometry],
      originalTextRegions: [region],
      ocrDocument: ocrDocument(originalSpace, [
        { id: 'line-manual', text: 'WAlT FOR ME', box: region.boundingBox },
      ]),
      coordinateSpace: originalSpace,
    });
    const reference = result.references[0]!;
    const corrected = correctBubbleDialogueReference(
      reference,
      {
        originalText: 'WAIT FOR ME!',
        lineCount: 1,
        alignment: 'center',
      },
      {
        bubbleIds: [reference.bubbleId],
        textRegionIds: [region.id],
        coordinateSpace: originalSpace,
      },
    );
    expect(corrected.originalText).toBe('WAIT FOR ME!');
    expect(corrected.status).toBe('edited');
    expect(corrected.method).toBe('manual');
    expect(corrected.revision).toBe(2);
    expect(() =>
      correctBubbleDialogueReference(
        reference,
        { textRegionIds: ['missing'] },
        {
          bubbleIds: [reference.bubbleId],
          textRegionIds: [region.id],
          coordinateSpace: originalSpace,
        },
      ),
    ).toThrow(/existing original text regions/);
  });
});
