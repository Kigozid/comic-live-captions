import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createImageSpace,
  type Bounds,
  type ImageSpace,
} from '@comic-captioner/shared';
import {
  deriveReadingOrder,
  detectPanels,
  PanelOrderError,
  type Panel,
  type ReadingOrderBubbleInput,
} from '@comic-captioner/bubble-engine';

const width = 400;
const height = 400;
const pageSpace = createImageSpace('panel-page', width, height);

function box(
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
  space: ImageSpace = pageSpace,
): Bounds<ImageSpace> {
  return { x, y, width: boxWidth, height: boxHeight, coordinateSpace: space };
}

function panel(id: string, bounds: Bounds<ImageSpace>): Panel {
  return {
    id,
    bounds,
    coordinateSpace: bounds.coordinateSpace,
    areaRatio:
      (bounds.width * bounds.height) /
      (bounds.coordinateSpace.dimensions.width *
        bounds.coordinateSpace.dimensions.height),
  };
}

function bubble(id: string, bounds: Bounds<ImageSpace>): ReadingOrderBubbleInput {
  return { id, boundingBox: bounds };
}

/** White page with black-bordered, gray-filled panels at the given rects. */
async function createPanelGridPage(
  rects: readonly {
    x: number;
    y: number;
    width: number;
    height: number;
  }[],
  pageWidth = width,
  pageHeight = height,
): Promise<Buffer> {
  const panels = rects
    .map(
      (rect) =>
        `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="#c0c0c0" stroke="#111" stroke-width="4"/>`,
    )
    .join('');
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth}" height="${pageHeight}"><rect width="100%" height="100%" fill="#fff"/>${panels}</svg>`,
  );
  return sharp(svg).png().toBuffer();
}

describe('detectPanels', () => {
  it('detects a single bordered panel on a white page', async () => {
    const space = createImageSpace('single-panel-page', 320, 240);
    const image = await createPanelGridPage(
      [{ x: 40, y: 30, width: 240, height: 180 }],
      320,
      240,
    );
    const result = await detectPanels(image, space);

    expect(result.panels).toHaveLength(1);
    expect(result.coordinateSpace.id).toBe(space.id);
    const bounds = result.panels[0]!.bounds;
    expect(bounds.coordinateSpace.id).toBe(space.id);
    expect(bounds.x).toBeGreaterThan(30);
    expect(bounds.x).toBeLessThan(50);
    expect(bounds.width).toBeGreaterThan(220);
    expect(bounds.width).toBeLessThan(260);
    expect(result.panels[0]!.areaRatio).toBeGreaterThan(0.3);
  });

  it('detects a 2x2 panel grid in row-major order', async () => {
    const image = await createPanelGridPage([
      { x: 20, y: 20, width: 170, height: 170 },
      { x: 210, y: 20, width: 170, height: 170 },
      { x: 20, y: 210, width: 170, height: 170 },
      { x: 210, y: 210, width: 170, height: 170 },
    ]);
    const result = await detectPanels(image, pageSpace);

    expect(result.panels).toHaveLength(4);
    // Row-major LTR: top-left, top-right, bottom-left, bottom-right.
    const [first, second, third, fourth] = result.panels;
    expect(first!.bounds.y).toBeLessThan(third!.bounds.y);
    expect(first!.bounds.x).toBeLessThan(second!.bounds.x);
    expect(third!.bounds.x).toBeLessThan(fourth!.bounds.x);
    expect(first!.id).toBe('panel-1');
    expect(fourth!.id).toBe('panel-4');
    for (const detected of result.panels) {
      expect(detected.bounds.width).toBeGreaterThan(150);
      expect(detected.bounds.height).toBeGreaterThan(150);
    }
  });

  it('returns no panels for an empty (blank) page', async () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/></svg>`,
    );
    const image = await sharp(svg).png().toBuffer();
    const result = await detectPanels(image, pageSpace);
    expect(result.panels).toEqual([]);
  });

  it('splits a joined region at an internal projection-profile gutter', async () => {
    // Two gray art blocks joined by a thin left bridge: one connected region
    // whose bounding box contains a full-width gutter band between the blocks.
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/><rect x="40" y="20" width="300" height="140" fill="#c0c0c0"/><rect x="40" y="180" width="300" height="140" fill="#c0c0c0"/><rect x="40" y="20" width="8" height="300" fill="#c0c0c0"/></svg>`,
    );
    const image = await sharp(svg).png().toBuffer();
    const result = await detectPanels(image, pageSpace);

    expect(result.panels).toHaveLength(2);
    expect(result.panels[0]!.bounds.y).toBeLessThan(result.panels[1]!.bounds.y);
    expect(result.panels[0]!.bounds.height).toBeGreaterThan(100);
    expect(result.panels[1]!.bounds.height).toBeGreaterThan(100);
  });

  it('rejects mismatched images and invalid options', async () => {
    const image = await createPanelGridPage([
      { x: 20, y: 20, width: 170, height: 170 },
    ]);
    await expect(
      detectPanels(image, createImageSpace('wrong', width + 1, height)),
    ).rejects.toThrow(/ImageSpace/);
    await expect(
      detectPanels(image, pageSpace, { minimumPanelAreaRatio: 2 }),
    ).rejects.toThrow(PanelOrderError);
  });
});

describe('deriveReadingOrder', () => {
  const topLeft = panel('p-tl', box(20, 20, 170, 170));
  const topRight = panel('p-tr', box(210, 20, 170, 170));
  const bottomLeft = panel('p-bl', box(20, 210, 170, 170));
  const bottomRight = panel('p-br', box(210, 210, 170, 170));
  const gridPanels = [topLeft, topRight, bottomLeft, bottomRight];

  it('orders a single panel bubble sequence', () => {
    const single = [panel('p-1', box(50, 50, 300, 300))];
    const bubbles = [
      bubble('b1', box(80, 80, 50, 30)),
      bubble('b2', box(80, 220, 50, 30)),
    ];
    expect(deriveReadingOrder(bubbles, single, 'ltr')).toEqual(['b1', 'b2']);
    expect(deriveReadingOrder(bubbles, single, 'rtl')).toEqual(['b1', 'b2']);
  });

  it('reads a 2x2 panel grid left-to-right or right-to-left per row', () => {
    const bubbles = [
      bubble('b-tl', box(40, 40, 60, 40)),
      bubble('b-tr', box(240, 50, 50, 40)),
      bubble('b-bl', box(50, 240, 60, 40)),
      bubble('b-br', box(250, 250, 50, 40)),
    ];
    expect(deriveReadingOrder(bubbles, gridPanels, 'ltr')).toEqual([
      'b-tl',
      'b-tr',
      'b-bl',
      'b-br',
    ]);
    expect(deriveReadingOrder(bubbles, gridPanels, 'rtl')).toEqual([
      'b-tr',
      'b-tl',
      'b-br',
      'b-bl',
    ]);
  });

  it('orders bubbles within a panel by position and assigns strays to the nearest panel', () => {
    const bubbles = [
      bubble('b-lower-left', box(40, 140, 50, 30)),
      bubble('b-right', box(130, 80, 50, 30)),
      bubble('b-upper-left', box(40, 80, 50, 30)),
      // Outside every panel on the far right; nearest panel is top-right.
      bubble('b-stray', box(392, 95, 8, 20)),
      bubble('b-br', box(250, 250, 50, 40)),
    ];
    expect(deriveReadingOrder(bubbles, gridPanels, 'ltr')).toEqual([
      'b-upper-left',
      'b-right',
      'b-lower-left',
      'b-stray',
      'b-br',
    ]);
    // RTL reverses each panel row: the stray (top-right panel) leads.
    expect(deriveReadingOrder(bubbles, gridPanels, 'rtl')).toEqual([
      'b-stray',
      'b-right',
      'b-upper-left',
      'b-lower-left',
      'b-br',
    ]);
  });

  it('handles an empty page and panels-less pages', () => {
    expect(deriveReadingOrder([], [], 'ltr')).toEqual([]);
    const loose = [
      bubble('b2', box(200, 20, 50, 30)),
      bubble('b1', box(40, 20, 50, 30)),
    ];
    expect(deriveReadingOrder(loose, [], 'rtl')).toEqual(['b2', 'b1']);
    expect(deriveReadingOrder(loose, [], 'ltr')).toEqual(['b1', 'b2']);
  });

  it('rejects invalid directions and mismatched geometry', () => {
    const bubbles = [bubble('b1', box(40, 40, 50, 30))];
    expect(() =>
      deriveReadingOrder(bubbles, gridPanels, 'ttb' as 'ltr'),
    ).toThrow(PanelOrderError);
    const wrongSpace = createImageSpace('other', width, height);
    expect(() =>
      deriveReadingOrder(
        [bubble('b1', box(40, 40, 50, 30, wrongSpace))],
        gridPanels,
        'ltr',
      ),
    ).toThrow(/ImageSpace/);
    expect(() =>
      deriveReadingOrder(
        [bubble('b1', box(40, 40, -5, 30))],
        gridPanels,
        'ltr',
      ),
    ).toThrow(/finite/);
  });
});
