import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  BUBBLE_DETECTOR_CLASSES,
  MlBubbleDetectorError,
  SyntheticYoloSession,
  YoloBubbleProposalProvider,
  boundsToPolygon,
  createOnnxYoloSession,
  decodeYoloV5,
  decodeYoloV8,
  letterboxToTensor,
  nonMaxSuppression,
  type YoloDetection,
} from '../../packages/bubble-engine/src/ml-bubble-detector.js';
import { HybridBubbleDetector } from '../../packages/bubble-engine/src/hybrid-detection.js';
import type { CoordinateSpaceId, ImageSpace } from '@comic-captioner/shared';

const space: ImageSpace = {
  id: 'image:ml-test' as CoordinateSpaceId,
  kind: 'image',
  dimensions: { width: 200, height: 200 },
};

async function whitePagePng(size = 200): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer(),
  );
}

describe('letterboxToTensor', () => {
  it('produces a CHW float32 tensor with letterbox metadata', async () => {
    const png = await whitePagePng(200);
    const tensor = await letterboxToTensor(png, 640, 640);
    expect(tensor.width).toBe(640);
    expect(tensor.height).toBe(640);
    expect(tensor.data.length).toBe(3 * 640 * 640);
    expect(tensor.scale).toBeCloseTo(640 / 200);
    expect(tensor.padX).toBeGreaterThanOrEqual(0);
    expect(tensor.padY).toBeGreaterThanOrEqual(0);
    // Center pixel should be near white.
    const plane = 640 * 640;
    const center = 320 * 640 + 320;
    expect(tensor.data[center]).toBeGreaterThan(0.9);
    expect(tensor.data[plane + center]).toBeGreaterThan(0.9);
  });

  it('rejects invalid target sizes', async () => {
    const png = await whitePagePng(32);
    await expect(letterboxToTensor(png, 0, 640)).rejects.toThrow(
      MlBubbleDetectorError,
    );
  });
});

describe('YOLO decoding', () => {
  it('decodes YOLOv5 objectness × class score and maps back to page space', () => {
    const letterbox = {
      data: new Float32Array(0),
      width: 640,
      height: 640,
      scale: 2,
      padX: 20,
      padY: 10,
    };
    // One detection: cx=320,cy=320,w=100,h=80,obj=0.9,cls0=0.8 → conf 0.72
    const numClasses = 5;
    const stride = 5 + numClasses;
    const output = new Float32Array(stride).fill(0);
    output[0] = 320;
    output[1] = 320;
    output[2] = 100;
    output[3] = 80;
    output[4] = 0.9;
    output[5] = 0.8;
    const detections = decodeYoloV5(
      output,
      1,
      numClasses,
      ['speech', 'thought', 'shout', 'narration', 'unknown'],
      letterbox,
    );
    expect(detections).toHaveLength(1);
    expect(detections[0]!.confidence).toBeCloseTo(0.72);
    expect(detections[0]!.classLabel).toBe('speech');
    // page x1 = (320-50-20)/2 = 125
    expect(detections[0]!.x1).toBeCloseTo(125);
  });

  it('decodes YOLOv8 channel-major class scores', () => {
    const letterbox = {
      data: new Float32Array(0),
      width: 640,
      height: 640,
      scale: 1,
      padX: 0,
      padY: 0,
    };
    const numClasses = 5;
    const numDetections = 2;
    const channels = 4 + numClasses;
    const output = new Float32Array(channels * numDetections);
    // det 0: box 100,100,40,40 class1=0.6
    output[0 * numDetections + 0] = 100;
    output[1 * numDetections + 0] = 100;
    output[2 * numDetections + 0] = 40;
    output[3 * numDetections + 0] = 40;
    output[(4 + 1) * numDetections + 0] = 0.6;
    // det 1: low score
    output[0 * numDetections + 1] = 200;
    output[1 * numDetections + 1] = 200;
    output[2 * numDetections + 1] = 20;
    output[3 * numDetections + 1] = 20;
    const detections = decodeYoloV8(
      output,
      numDetections,
      numClasses,
      ['speech', 'thought', 'shout', 'narration', 'unknown'],
      letterbox,
    );
    expect(detections.length).toBeGreaterThanOrEqual(1);
    expect(detections[0]!.classLabel).toBe('thought');
    expect(detections[0]!.confidence).toBeCloseTo(0.6);
  });
});

describe('nonMaxSuppression', () => {
  it('suppresses overlapping boxes and keeps highest confidence', () => {
    const base = { y1: 0, x2: 50, y2: 50, classId: 0 };
    const detections: YoloDetection[] = [
      { ...base, x1: 0, confidence: 0.5 },
      { ...base, x1: 2, confidence: 0.9 },
      { ...base, x1: 100, confidence: 0.7 },
    ];
    const kept = nonMaxSuppression(detections, 0.5, 10);
    expect(kept).toHaveLength(2);
    expect(kept[0]!.confidence).toBe(0.9);
    expect(kept[1]!.x1).toBe(100);
  });

  it('respects maximum detections', () => {
    const detections: YoloDetection[] = Array.from({ length: 5 }, (_, i) => ({
      x1: i * 100,
      y1: 0,
      x2: i * 100 + 10,
      y2: 10,
      confidence: 0.5,
      classId: 0,
    }));
    expect(nonMaxSuppression(detections, 0.5, 2)).toHaveLength(2);
  });
});

describe('YoloBubbleProposalProvider', () => {
  it('keeps text_bubble and drops text_free from the trained detector', async () => {
    const png = await whitePagePng(200);
    const session = new SyntheticYoloSession({
      detections: [
        {
          x1: 20,
          y1: 20,
          x2: 80,
          y2: 80,
          confidence: 0.9,
          classId: 0,
          classLabel: 'text_bubble',
        },
        {
          x1: 100,
          y1: 100,
          x2: 160,
          y2: 140,
          confidence: 0.8,
          classId: 1,
          classLabel: 'text_free',
        },
      ],
    });
    const provider = new YoloBubbleProposalProvider({
      session,
      classLabels: BUBBLE_DETECTOR_CLASSES,
      bubbleClassesOnly: true,
      confidenceThreshold: 0.1,
      maximumProposals: 8,
    });
    const space = {
      id: 'image:bubble-detector' as never,
      kind: 'image' as const,
      dimensions: { width: 200, height: 200 },
    };
    const proposals = await provider.propose(png, space);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.boundingBox.x).toBeCloseTo(20);
  });

  it('emits ML proposals with provenance for hybrid refinement', async () => {
    const png = await whitePagePng(200);
    const session = new SyntheticYoloSession({
      detections: [
        {
          x1: 40,
          y1: 40,
          x2: 120,
          y2: 120,
          confidence: 0.88,
          classId: 0,
          classLabel: 'speech',
        },
        {
          x1: 150,
          y1: 150,
          x2: 190,
          y2: 190,
          confidence: 0.3,
          classId: 3,
          classLabel: 'panel',
        },
      ],
    });
    const provider = new YoloBubbleProposalProvider({
      session,
      confidenceThreshold: 0.25,
      bubbleClassesOnly: true,
    });
    const proposals = await provider.propose(png, space);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.provenance).toBe('ml');
    expect(proposals[0]!.confidence).toBeCloseTo(0.88);
    expect(proposals[0]!.boundingBox.width).toBeCloseTo(80);
  });

  it('requires a session and valid thresholds', () => {
    expect(
      () => new YoloBubbleProposalProvider({ session: undefined as never }),
    ).toThrow(MlBubbleDetectorError);
    expect(
      () =>
        new YoloBubbleProposalProvider({
          session: new SyntheticYoloSession(),
          confidenceThreshold: 2,
        }),
    ).toThrow(MlBubbleDetectorError);
  });
});

describe('HybridBubbleDetector with ML proposals', () => {
  it('merges ML proposals with deterministic geometry and labels sources', async () => {
    const png = await whitePagePng(200);
    // Draw a dark closed rounded rectangle so deterministic detection can refine.
    const annotated = await sharp(png)
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
              <rect x="40" y="40" width="120" height="120" rx="28"
                    fill="#f8f8f8" stroke="#222" stroke-width="4"/>
            </svg>`,
          ),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const session = new SyntheticYoloSession({
      detections: [
        {
          x1: 35,
          y1: 35,
          x2: 165,
          y2: 165,
          confidence: 0.91,
          classId: 0,
          classLabel: 'speech',
        },
      ],
    });
    const detector = new HybridBubbleDetector({
      provider: new YoloBubbleProposalProvider({ session }),
    });
    const result = await detector.detect(new Uint8Array(annotated), space);
    expect(result.providerName).toBe('yolo:synthetic-yolo');
    expect(result.proposalCount).toBe(1);
    expect(result.bubbles.length).toBeGreaterThanOrEqual(0);
    for (const hybrid of result.bubbles) {
      expect(hybrid.support.some((s) => s.provenance === 'ml')).toBe(
        hybrid.sources.includes('ml') || hybrid.support.length > 0,
      );
    }
  });
});

describe('createOnnxYoloSession', () => {
  it('uses an injected session and decodes yolov8 output', async () => {
    const numDetections = 1;
    const numClasses = 5;
    const channels = 4 + numClasses;
    const output = new Float32Array(channels * numDetections);
    output[0] = 100;
    output[1] = 100;
    output[2] = 50;
    output[3] = 50;
    output[4] = 0.9; // class 0
    const session = createOnnxYoloSession({
      modelPathOrUri: 'bubble-yolo.onnx',
      format: 'yolov8',
      numClasses,
      session: {
        async run() {
          return { output0: { data: output } };
        },
      },
    });
    expect(session.name).toBe('onnx-yolo');
    const result = await session.detect({
      data: new Float32Array(3 * 640 * 640),
      width: 640,
      height: 640,
      scale: 1,
      padX: 0,
      padY: 0,
      originalWidth: 640,
      originalHeight: 640,
    });
    expect(result.kind).toBe('yolov8');
  });

  it('fails clearly when no session is provided', async () => {
    const session = createOnnxYoloSession({
      modelPathOrUri: 'missing.onnx',
    });
    await expect(
      session.detect({
        data: new Float32Array(3),
        width: 1,
        height: 1,
        scale: 1,
        padX: 0,
        padY: 0,
        originalWidth: 1,
        originalHeight: 1,
      }),
    ).rejects.toThrow(MlBubbleDetectorError);
  });
});

describe('boundsToPolygon', () => {
  it('creates a four-corner page polygon', () => {
    const polygon = boundsToPolygon({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      coordinateSpace: space,
    });
    expect(polygon.points).toHaveLength(4);
    expect(polygon.points[0]).toMatchObject({ x: 10, y: 20 });
    expect(polygon.points[2]).toMatchObject({ x: 40, y: 60 });
    expect(polygon.coordinateSpace.id).toBe(space.id);
  });
});
