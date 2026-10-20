import { describe, expect, it } from 'vitest';
import { createImage } from '../fixtures/image-fixtures.js';
import {
  applyOCRCorrection,
  OCRError,
  ValidatingOCRService,
  type OCRInput,
  type OCRProvider,
} from '@comic-captioner/image-engine';
import { createImageSpace } from '@comic-captioner/shared';

const space = createImageSpace('fixture-page', 120, 80);

function response() {
  const box = (x: number, y: number, width: number, height: number) => ({
    x,
    y,
    width,
    height,
    coordinateSpace: space,
  });
  return {
    id: 'document-1',
    text: 'HELLO',
    boundingBox: box(10, 10, 55, 20),
    confidence: 0.96,
    coordinateSpace: space,
    blocks: [
      {
        id: 'block-1',
        text: 'HELLO',
        boundingBox: box(10, 10, 55, 20),
        confidence: 0.95,
        coordinateSpace: space,
        lines: [
          {
            id: 'line-1',
            text: 'HELLO',
            boundingBox: box(10, 10, 55, 20),
            confidence: 0.94,
            coordinateSpace: space,
            words: [
              {
                id: 'word-1',
                text: 'HELLO',
                boundingBox: box(10, 10, 55, 20),
                confidence: 0.93,
                coordinateSpace: space,
              },
            ],
          },
        ],
      },
    ],
  };
}

function providerFor(
  result: unknown,
  observe?: (input: OCRInput) => void,
): OCRProvider {
  return {
    providerId: 'fixture-provider',
    providerVersion: '1',
    async recognize(input) {
      observe?.(input);
      return result;
    },
  };
}

describe('OCR service', () => {
  it('normalizes fixture image provider output to the page coordinate space', async () => {
    const image = await createImage(120, 80);
    let received: OCRInput | undefined;
    const service = new ValidatingOCRService(
      providerFor(response(), (input) => {
        received = input;
      }),
    );
    const document = await service.recognize({
      image,
      mediaType: 'image/png',
      coordinateSpace: space,
    });

    expect(received?.image.byteLength).toBe(image.byteLength);
    expect(document.text).toBe('HELLO');
    expect(document.provenance.source).toBe('fixture-provider');
    expect(document.provenance.inputHashes[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(document.blocks[0]?.lines[0]?.words[0]?.coordinateSpace.id).toBe(
      space.id,
    );
    expect(document.reviewStatus).toBe('pending-review');
    expect(
      Object.isFrozen(document.blocks[0]?.lines[0]?.words[0]?.boundingBox),
    ).toBe(true);
  });

  it('rejects malformed confidence, duplicate IDs, and geometry in another image space', async () => {
    const badConfidence = response() as ReturnType<typeof response> & {
      confidence: number;
    };
    badConfidence.confidence = 1.1;
    await expect(
      new ValidatingOCRService(providerFor(badConfidence)).recognize({
        image: new Uint8Array([1]),
        mediaType: 'image/png',
        coordinateSpace: space,
      }),
    ).rejects.toBeInstanceOf(OCRError);

    const duplicateId = response();
    duplicateId.blocks[0]!.id = duplicateId.id;
    await expect(
      new ValidatingOCRService(providerFor(duplicateId)).recognize({
        image: new Uint8Array([1]),
        mediaType: 'image/png',
        coordinateSpace: space,
      }),
    ).rejects.toThrow(/Duplicate OCR ID/);

    const wrongSpace = response();
    wrongSpace.blocks[0]!.lines[0]!.words[0]!.coordinateSpace =
      createImageSpace('other-page', 200, 80);
    await expect(
      new ValidatingOCRService(providerFor(wrongSpace)).recognize({
        image: new Uint8Array([1]),
        mediaType: 'image/png',
        coordinateSpace: space,
      }),
    ).rejects.toThrow(/image space/);
  });

  it('applies manual word correction immutably and increments the review revision', async () => {
    const document = await new ValidatingOCRService(
      providerFor(response()),
    ).recognize({
      image: await createImage(120, 80),
      mediaType: 'image/png',
      coordinateSpace: space,
    });
    const corrected = applyOCRCorrection(document, {
      targetKind: 'word',
      targetId: 'word-1',
      text: 'HELLO!',
      boundingBox: {
        x: 9,
        y: 10,
        width: 60,
        height: 20,
        coordinateSpace: space,
      },
    });

    expect(document.blocks[0]?.lines[0]?.words[0]?.text).toBe('HELLO');
    expect(corrected.blocks[0]?.lines[0]?.words[0]?.text).toBe('HELLO!');
    expect(corrected.blocks[0]?.lines[0]?.text).toBe('HELLO!');
    expect(corrected.text).toBe('HELLO!');
    expect(corrected.revision).toBe(2);
    expect(corrected.reviewStatus).toBe('edited');
  });

  it('rejects corrections for missing nodes and out-of-bounds geometry', async () => {
    const document = await new ValidatingOCRService(
      providerFor(response()),
    ).recognize({
      image: await createImage(120, 80),
      mediaType: 'image/png',
      coordinateSpace: space,
    });
    expect(() =>
      applyOCRCorrection(document, {
        targetKind: 'word',
        targetId: 'missing',
        text: 'x',
      }),
    ).toThrow(/not found/);
    expect(() =>
      applyOCRCorrection(document, {
        targetKind: 'word',
        targetId: 'word-1',
        boundingBox: {
          x: 119,
          y: 10,
          width: 10,
          height: 10,
          coordinateSpace: space,
        },
      }),
    ).toThrow(/inside its image space/);
  });

  it('retargets same-page geometry under a different space id', async () => {
    const otherSpace = createImageSpace('workspace:imported-page', 120, 80);
    const remapped = {
      ...response(),
      coordinateSpace: otherSpace,
      boundingBox: {
        ...response().boundingBox,
        coordinateSpace: otherSpace,
      },
      blocks: response().blocks.map((block) => ({
        ...block,
        coordinateSpace: otherSpace,
        boundingBox: { ...block.boundingBox, coordinateSpace: otherSpace },
        lines: block.lines.map((line) => ({
          ...line,
          coordinateSpace: otherSpace,
          boundingBox: { ...line.boundingBox, coordinateSpace: otherSpace },
          words: line.words.map((word) => ({
            ...word,
            coordinateSpace: otherSpace,
            boundingBox: { ...word.boundingBox, coordinateSpace: otherSpace },
          })),
        })),
      })),
    };
    const service = new ValidatingOCRService(providerFor(remapped));
    const document = await service.recognize({
      image: new Uint8Array([1]),
      mediaType: 'image/png',
      coordinateSpace: space,
    });
    expect(document.coordinateSpace.id).toBe(space.id);
    expect(document.blocks[0]!.coordinateSpace.id).toBe(space.id);
    expect(document.blocks[0]!.lines[0]!.text).toBe('HELLO');
  });

  it('surfaces provider failures without converting them into OCR output', async () => {
    const provider: OCRProvider = {
      providerId: 'offline',
      providerVersion: '1',
      async recognize() {
        throw new Error('provider unavailable');
      },
    };
    await expect(
      new ValidatingOCRService(provider).recognize({
        image: new Uint8Array([1]),
        mediaType: 'image/png',
        coordinateSpace: space,
      }),
    ).rejects.toThrow('provider unavailable');
  });
});
