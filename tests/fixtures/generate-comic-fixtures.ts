import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const width = 640;
const height = 480;
type Shape = 'ellipse' | 'irregular' | 'rect' | 'thought' | 'rounded';
interface SpecBubble {
  readonly id: string;
  readonly shape: Shape;
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly font?: string;
  readonly rotation?: number;
  readonly tail?: readonly [number, number][];
}
interface FixtureSpec {
  readonly name: string;
  readonly bubbles: readonly SpecBubble[];
}

const ellipsePoints = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n = 64,
) =>
  Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2;
    return {
      x: round(cx + Math.cos(angle) * rx),
      y: round(cy + Math.sin(angle) * ry),
    };
  });
const round = (value: number) => Math.round(value * 100) / 100;
function polygonFor(bubble: SpecBubble) {
  if (bubble.shape === 'ellipse')
    return ellipsePoints(bubble.cx, bubble.cy, bubble.w / 2, bubble.h / 2);
  if (bubble.shape === 'irregular' || bubble.shape === 'thought') {
    const count = bubble.shape === 'thought' ? 72 : 24;
    return Array.from({ length: count }, (_, index) => {
      const angle = (index * Math.PI * 2) / count;
      const variation =
        bubble.shape === 'thought'
          ? index % 6 === 0
            ? 1.04
            : 0.94
          : index % 2 === 0
            ? 1
            : 0.78;
      return {
        x: round(bubble.cx + ((Math.cos(angle) * bubble.w) / 2) * variation),
        y: round(bubble.cy + ((Math.sin(angle) * bubble.h) / 2) * variation),
      };
    });
  }
  const radius =
    bubble.shape === 'rounded' ? Math.min(bubble.h * 0.17, bubble.w * 0.1) : 0;
  if (!radius)
    return [
      { x: bubble.cx - bubble.w / 2, y: bubble.cy - bubble.h / 2 },
      { x: bubble.cx + bubble.w / 2, y: bubble.cy - bubble.h / 2 },
      { x: bubble.cx + bubble.w / 2, y: bubble.cy + bubble.h / 2 },
      { x: bubble.cx - bubble.w / 2, y: bubble.cy + bubble.h / 2 },
    ];
  const corners = [
    [bubble.cx + bubble.w / 2 - radius, bubble.cy - bubble.h / 2 + radius, -90],
    [bubble.cx + bubble.w / 2 - radius, bubble.cy + bubble.h / 2 - radius, 0],
    [bubble.cx - bubble.w / 2 + radius, bubble.cy + bubble.h / 2 - radius, 90],
    [bubble.cx - bubble.w / 2 + radius, bubble.cy - bubble.h / 2 + radius, 180],
  ] as const;
  return corners.flatMap(([cx, cy, start]) =>
    Array.from({ length: 9 }, (_, index) => {
      const angle = ((start + (index * 90) / 8) * Math.PI) / 180;
      return {
        x: round(cx + Math.cos(angle) * radius),
        y: round(cy + Math.sin(angle) * radius),
      };
    }),
  );
}
function svgPolygon(points: readonly { x: number; y: number }[]) {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}
function bounds(points: readonly { x: number; y: number }[]) {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    x: round(left),
    y: round(top),
    width: round(right - left),
    height: round(bottom - top),
  };
}

const specs: readonly FixtureSpec[] = [
  {
    name: 'simple',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'rounded',
        cx: 320,
        cy: 220,
        w: 380,
        h: 230,
        text: 'HELLO',
        start: 0.2,
        end: 1.4,
        tail: [
          [300, 320],
          [278, 385],
          [340, 320],
        ],
      },
    ],
  },
  {
    name: 'ellipse',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'ellipse',
        cx: 320,
        cy: 225,
        w: 460,
        h: 280,
        text: 'STAY CLOSE',
        start: 0.3,
        end: 1.8,
      },
    ],
  },
  {
    name: 'irregular',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'irregular',
        cx: 320,
        cy: 225,
        w: 470,
        h: 300,
        text: 'LOOK OUT!',
        start: 0.5,
        end: 1.25,
        tail: [
          [405, 337],
          [457, 405],
          [435, 324],
        ],
      },
    ],
  },
  {
    name: 'multiple-bubbles',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'ellipse',
        cx: 180,
        cy: 150,
        w: 250,
        h: 165,
        text: 'READY?',
        start: 0.1,
        end: 0.9,
      },
      {
        id: 'bubble-2',
        shape: 'rounded',
        cx: 462,
        cy: 315,
        w: 260,
        h: 175,
        text: 'YES!',
        start: 1.1,
        end: 1.75,
      },
    ],
  },
  {
    name: 'overlapping',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'ellipse',
        cx: 270,
        cy: 215,
        w: 370,
        h: 250,
        text: 'WAIT',
        start: 0.2,
        end: 0.95,
      },
      {
        id: 'bubble-2',
        shape: 'ellipse',
        cx: 420,
        cy: 255,
        w: 330,
        h: 235,
        text: 'GO!',
        start: 0.72,
        end: 1.5,
      },
    ],
  },
  {
    name: 'cropped',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'ellipse',
        cx: 12,
        cy: 230,
        w: 330,
        h: 300,
        text: 'WHO IS THERE?',
        start: 0.4,
        end: 1.7,
      },
    ],
  },
  {
    name: 'narration',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'rect',
        cx: 320,
        cy: 100,
        w: 510,
        h: 135,
        text: 'LATER THAT DAY',
        start: 0,
        end: 1.2,
        font: 'serif',
      },
    ],
  },
  {
    name: 'thought-bubble',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'thought',
        cx: 320,
        cy: 220,
        w: 450,
        h: 280,
        text: 'I WONDER...',
        start: 0.3,
        end: 1.6,
      },
    ],
  },
  {
    name: 'long-dialogue',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'ellipse',
        cx: 320,
        cy: 230,
        w: 570,
        h: 370,
        text: 'WE SHOULD TAKE THE NORTH ROAD BEFORE THE STORM REACHES THE VALLEY',
        start: 0.25,
        end: 3.4,
      },
    ],
  },
  {
    name: 'difficult-lettering',
    bubbles: [
      {
        id: 'bubble-1',
        shape: 'irregular',
        cx: 320,
        cy: 235,
        w: 520,
        h: 330,
        text: 'KRAK!!',
        start: 0.05,
        end: 0.55,
        font: 'serif',
        rotation: -8,
      },
    ],
  },
];

for (const spec of specs) {
  const directory = path.join('tests/fixtures', spec.name);
  await mkdir(path.join(directory, 'expected'), { recursive: true });
  const shapes = spec.bubbles.map((bubble) => {
    const points = polygonFor(bubble);
    const polygon = svgPolygon(points);
    const tail = bubble.tail
      ? `<polygon points="${svgPolygon(bubble.tail.map(([x, y]) => ({ x, y })))}" fill="#fff" stroke="#111" stroke-width="5"/>`
      : '';
    const label =
      bubble.shape === 'rect'
        ? 'rect'
        : bubble.shape === 'rounded'
          ? 'rect'
          : 'polygon';
    const body =
      bubble.shape === 'rect'
        ? `<rect x="${bubble.cx - bubble.w / 2}" y="${bubble.cy - bubble.h / 2}" width="${bubble.w}" height="${bubble.h}" fill="#fff" stroke="#111" stroke-width="5"/>`
        : bubble.shape === 'rounded'
          ? `<rect x="${bubble.cx - bubble.w / 2}" y="${bubble.cy - bubble.h / 2}" width="${bubble.w}" height="${bubble.h}" rx="28" fill="#fff" stroke="#111" stroke-width="5"/>`
          : `<polygon points="${polygon}" fill="#fff" stroke="#111" stroke-width="5"/>`;
    const textWidth = Math.min(
      bubble.w * 0.78,
      Math.max(65, bubble.text.length * bubble.h * 0.07),
    );
    const textHeight = bubble.h * 0.19;
    const textBox = {
      x: round(bubble.cx - textWidth / 2),
      y: round(bubble.cy - textHeight / 2),
      width: round(textWidth),
      height: round(textHeight),
    };
    const transform = bubble.rotation
      ? ` transform="rotate(${bubble.rotation} ${bubble.cx} ${bubble.cy})"`
      : '';
    const text = `<text x="${bubble.cx}" y="${bubble.cy + textHeight * 0.34}" text-anchor="middle" font-family="${bubble.font ?? 'sans-serif'}" font-size="${textHeight}" font-weight="700"${transform}>${bubble.text}</text>`;
    return {
      bubble,
      points,
      polygon,
      tail,
      body,
      text,
      textBox,
      textWidth,
      label,
    };
  });
  const page =
    '<rect width="640" height="480" fill="#d8d8d8"/><rect x="10" y="10" width="620" height="460" fill="none" stroke="#222" stroke-width="8"/>';
  const base = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${page}${shapes.map((shape) => shape.body + shape.tail).join('')}</svg>`;
  const original = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${page}${shapes.map((shape) => shape.body + shape.tail + shape.text).join('')}</svg>`;
  await sharp(Buffer.from(original))
    .png()
    .toFile(path.join(directory, 'original.png'));
  await sharp(Buffer.from(base))
    .png()
    .toFile(path.join(directory, 'cleaned.png'));
  const expectedBubbles = [];
  const expectedTextRegions = [];
  const expectedOcr = [];
  const expectedDialogueMappings = [];
  for (const shape of shapes) {
    const bubble = shape.bubble;
    const bubbleMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><polygon points="${shape.polygon}" fill="white"/></svg>`;
    const textMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><rect x="${shape.textBox.x}" y="${shape.textBox.y}" width="${shape.textBox.width}" height="${shape.textBox.height}" fill="white"/></svg>`;
    const bubbleMaskFile = `expected/${bubble.id}-mask.png`;
    const textMaskFile = `expected/${bubble.id}-text-mask.png`;
    await sharp(Buffer.from(bubbleMask))
      .png()
      .toFile(path.join(directory, bubbleMaskFile));
    await sharp(Buffer.from(textMask))
      .png()
      .toFile(path.join(directory, textMaskFile));
    const box = bounds(shape.points);
    expectedBubbles.push({
      id: bubble.id,
      kind:
        bubble.shape === 'thought'
          ? 'thought'
          : bubble.shape === 'rect'
            ? 'narration'
            : 'speech',
      polygon: shape.points,
      boundingBox: box,
      tail: bubble.tail?.map(([x, y]) => ({ x, y })) ?? null,
      maskFile: bubbleMaskFile,
    });
    expectedTextRegions.push({
      id: `text-${bubble.id}`,
      bubbleId: bubble.id,
      boundingBox: shape.textBox,
      polygon: [
        { x: shape.textBox.x, y: shape.textBox.y },
        { x: shape.textBox.x + shape.textBox.width, y: shape.textBox.y },
        {
          x: shape.textBox.x + shape.textBox.width,
          y: shape.textBox.y + shape.textBox.height,
        },
        { x: shape.textBox.x, y: shape.textBox.y + shape.textBox.height },
      ],
      maskFile: textMaskFile,
    });
    expectedOcr.push({
      id: `ocr-${bubble.id}`,
      bubbleId: bubble.id,
      text: bubble.text,
      confidence: 1,
      boundingBox: shape.textBox,
      coordinateSpaceId: 'image:page',
    });
    expectedDialogueMappings.push({
      id: `mapping-${bubble.id}`,
      transcriptSegmentId: `segment-${bubble.id}`,
      bubbleId: bubble.id,
      confidence: 1,
      expectedIntervalSeconds: { start: bubble.start, end: bubble.end },
    });
  }
  const truth = {
    schemaVersion: 1,
    id: spec.name,
    description: `Synthetic ${spec.name} comic page pair; generated vector art, not scanned or licensed comic material.`,
    dimensions: { width, height },
    coordinateSpace: {
      id: 'image:page',
      kind: 'image',
      pixelCenters: 'integer',
      origin: 'top-left',
      xAxis: 'right',
      yAxis: 'down',
    },
    sourceFiles: { original: 'original.png', cleaned: 'cleaned.png' },
    expected: {
      bubbles: expectedBubbles,
      textRegions: expectedTextRegions,
      ocr: expectedOcr,
      dialogueMappings: expectedDialogueMappings,
    },
  };
  await writeFile(
    path.join(directory, 'ground-truth.json'),
    `${JSON.stringify(truth, null, 2)}\n`,
  );
}
console.log(`Generated ${specs.length} paired synthetic fixtures.`);
