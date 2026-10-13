import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import {
  cropBoundsToImage,
  paddlePolygonBounds,
} from '../../apps/web/src/paddle-ocr';

describe('PaddleOCR coordinate adaptation', () => {
  it('turns a PaddleOCR polygon into page ImageSpace pixel-edge bounds', () => {
    const page = createImageSpace('paddle-test-page', 100, 80);
    expect(
      paddlePolygonBounds(
        [
          [12, 10],
          [48, 10],
          [48, 22],
          [12, 22],
        ],
        page,
      ),
    ).toEqual({
      x: 12,
      y: 10,
      width: 36,
      height: 12,
      coordinateSpace: page,
    });
  });

  it('clips detections to image edges and rejects invalid polygons', () => {
    const page = createImageSpace('paddle-edge-page', 100, 80);
    expect(
      paddlePolygonBounds(
        [
          [-20, 70],
          [120, 70],
          [120, 90],
          [-20, 90],
        ],
        page,
      ),
    ).toEqual({
      x: -0.5,
      y: 70,
      width: 100,
      height: 9.5,
      coordinateSpace: page,
    });
    expect(
      paddlePolygonBounds(
        [
          [1, 1],
          [2, 2],
        ],
        page,
      ),
    ).toBeNull();
    expect(
      paddlePolygonBounds(
        [
          [Number.NaN, 1],
          [2, 2],
          [3, 3],
        ],
        page,
      ),
    ).toBeNull();
  });

  it('maps OCR boxes from upscaled bubble crops into page ImageSpace', () => {
    const page = createImageSpace('paddle-crop-page', 400, 300);
    const crop = createImageSpace('paddle-crop', 200, 100);
    const cropBounds = paddlePolygonBounds(
      [
        [20, 10],
        [80, 10],
        [80, 30],
        [20, 30],
      ],
      crop,
    );
    expect(cropBounds).not.toBeNull();
    expect(cropBoundsToImage(cropBounds!, { x: 100, y: 40 }, 2, page)).toEqual({
      x: 110,
      y: 45,
      width: 30,
      height: 10,
      coordinateSpace: page,
    });
  });
});
