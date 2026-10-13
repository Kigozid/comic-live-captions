import { describe, expect, it } from 'vitest';
import {
  CoordinateSpaceError,
  canvasToDisplay,
  createCanvasSpace,
  createDisplaySpace,
  createExportSpace,
  createImageSpace,
  createNormalizedSpace,
  displayToCanvas,
  displayToImage,
  exportToImage,
  imageToDisplay,
  imageToExport,
  imageToNormalized,
  normalizedToImage,
} from '@comic-captioner/shared';

describe('formal coordinate spaces', () => {
  it('converts raster pixel centers through fit scaling and back', () => {
    const image = createImageSpace('image:comic', 1000, 500);
    const display = createDisplaySpace({
      id: 'display:comic',
      dimensions: { width: 500, height: 400 },
      imageSpace: image,
      fitScale: 0.5,
    });
    const source = { x: 99.5, y: 49.5, coordinateSpace: image };
    const displayed = imageToDisplay(source, display);
    expect(displayed.x).toBeCloseTo(49.5);
    expect(displayed.y).toBeCloseTo(99.5);
    expect(displayToImage(displayed, display, image)).toMatchObject({
      x: source.x,
      y: source.y,
    });
  });

  it('includes user zoom and pan in display mapping', () => {
    const image = createImageSpace('image:zoom', 100, 50);
    const display = createDisplaySpace({
      id: 'display:zoom',
      dimensions: { width: 300, height: 200 },
      imageSpace: image,
      fitScale: 2,
      zoom: 1.5,
      origin: { x: 40, y: 30 },
      pan: { x: 13, y: -7 },
    });
    const source = { x: 10, y: 20, coordinateSpace: image };
    const displayed = imageToDisplay(source, display);
    expect(displayed.x).toBeCloseTo(40 + 13 + 10.5 * 3 - 0.5);
    expect(displayed.y).toBeCloseTo(30 - 7 + 20.5 * 3 - 0.5);
    expect(displayToImage(displayed, display, image)).toMatchObject({
      x: source.x,
      y: source.y,
    });
  });

  it('normalizes equivalent locations across different source resolutions', () => {
    const low = createImageSpace('image:low', 100, 50);
    const high = createImageSpace('image:high', 200, 100);
    const lowNormalized = createNormalizedSpace('normalized:low', low);
    const highNormalized = createNormalizedSpace('normalized:high', high);
    const lowPoint = imageToNormalized(
      { x: 9.5, y: 4.5, coordinateSpace: low },
      lowNormalized,
      low,
    );
    const highPoint = imageToNormalized(
      { x: 19.5, y: 9.5, coordinateSpace: high },
      highNormalized,
      high,
    );
    expect(lowPoint.x).toBeCloseTo(0.1);
    expect(lowPoint.y).toBeCloseTo(0.1);
    expect(highPoint.x).toBeCloseTo(lowPoint.x);
    expect(highPoint.y).toBeCloseTo(lowPoint.y);
    expect(normalizedToImage(lowPoint, lowNormalized, low)).toMatchObject({
      x: 9.5,
      y: 4.5,
    });
  });

  it('maps image pixels to differently sized export resolutions and back', () => {
    const image = createImageSpace('image:export', 1600, 900);
    const exported = createExportSpace({
      id: 'export:poster',
      dimensions: { width: 800, height: 450 },
      imageSpace: image,
    });
    const point = { x: 319.5, y: 179.5, coordinateSpace: image };
    const exportPoint = imageToExport(point, exported, image);
    expect(exportPoint.x).toBeCloseTo(159.5);
    expect(exportPoint.y).toBeCloseTo(89.5);
    expect(exportToImage(exportPoint, exported, image)).toMatchObject({
      x: point.x,
      y: point.y,
    });
  });

  it.each([1, 1.5, 2, 3])(
    'round trips display/canvas coordinates at DPR %s',
    (dpr) => {
      const image = createImageSpace(`image:dpr:${dpr}`, 100, 60);
      const display = createDisplaySpace({
        id: `display:dpr:${dpr}`,
        dimensions: { width: 400, height: 300 },
        imageSpace: image,
      });
      const canvas = createCanvasSpace({
        id: `canvas:dpr:${dpr}`,
        dimensions: { width: 400 * dpr, height: 300 * dpr },
        displaySpace: display,
        devicePixelRatio: dpr,
      });
      const cssPixel = { x: 10, y: 20, coordinateSpace: display };
      const backingPixel = displayToCanvas(cssPixel, canvas);
      expect(canvasToDisplay(backingPixel, canvas, display)).toMatchObject({
        x: cssPixel.x,
        y: cssPixel.y,
      });
      if (dpr === 2) expect(backingPixel.x).toBeCloseTo(20.5);
    },
  );

  it('rejects geometry that declares a different source coordinate space', () => {
    const image = createImageSpace('image:expected', 100, 100);
    const other = createImageSpace('image:other', 100, 100);
    const normalized = createNormalizedSpace('normalized:expected', image);
    expect(() =>
      imageToNormalized(
        { x: 0, y: 0, coordinateSpace: other },
        normalized,
        image,
      ),
    ).toThrow(CoordinateSpaceError);
  });
});
