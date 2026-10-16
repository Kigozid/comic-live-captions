import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const modelsDir = path.resolve(process.cwd(), 'models');
const bubbleDetectorPath = path.join(
  modelsDir,
  'bubble-yolo',
  'comic-speech-bubble-detector.onnx',
);
const yoloModelPath = path.join(modelsDir, 'bubble-yolo', 'model.onnx');
const wav2vecModelPath = path.join(
  modelsDir,
  'wav2vec2',
  'model_quantized.onnx',
);

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const hasBubbleDetector = await exists(bubbleDetectorPath);
const hasYolo = (await exists(yoloModelPath)) || hasBubbleDetector;
const hasWav2vec = await exists(wav2vecModelPath);
const hasOrt = await import('onnxruntime-node')
  .then(() => true)
  .catch(() => false);

describe('real ONNX weights', () => {
  it('model files are present (run `pnpm models:fetch` if skipped)', () => {
    // Informational: skip hard failure when weights were not downloaded.
    if (!hasYolo || !hasWav2vec) {
      console.warn(
        `ONNX weights missing (yolo=${hasYolo}, wav2vec=${hasWav2vec}). Run: corepack pnpm models:fetch`,
      );
    }
    expect(true).toBe(true);
  });

  it.runIf(hasBubbleDetector && hasOrt)(
    'loads comic-speech-bubble-detector ONNX and proposes bubble boxes',
    async () => {
      const { loadYoloOnnxSession } = await import(
        '../../apps/api/src/onnx-models.js'
      );
      const {
        BUBBLE_DETECTOR_CLASSES,
        YoloBubbleProposalProvider,
        letterboxToTensor,
      } = await import('../../packages/bubble-engine/src/ml-bubble-detector.js');
      const sharp = (await import('sharp')).default;

      const size = 200;
      const png = new Uint8Array(
        await sharp({
          create: {
            width: size,
            height: size,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
                   <rect x="50" y="50" width="100" height="100" rx="30"
                         fill="#f5f5f5" stroke="#111" stroke-width="6"/>
                 </svg>`,
              ),
            },
          ])
          .png()
          .toBuffer(),
      );

      const session = await loadYoloOnnxSession({
        modelPath: bubbleDetectorPath,
      });
      expect(session.name).toContain('comic-speech-bubble-detector');
      expect(session.inputWidth).toBe(1024);
      expect(
        (session as { classLabels?: readonly string[] }).classLabels,
      ).toEqual(BUBBLE_DETECTOR_CLASSES);

      const space = {
        id: 'image:onnx-bubble' as never,
        kind: 'image' as const,
        dimensions: { width: size, height: size },
      };
      const provider = new YoloBubbleProposalProvider({
        session,
        classLabels: BUBBLE_DETECTOR_CLASSES,
        confidenceThreshold: 0.05,
        bubbleClassesOnly: true,
        maximumProposals: 16,
      });
      const proposals = await provider.propose(png, space);
      expect(Array.isArray(proposals)).toBe(true);
      for (const proposal of proposals) {
        expect(proposal.provenance).toBe('ml');
        expect(proposal.boundingBox.width).toBeGreaterThan(0);
        expect(proposal.boundingBox.height).toBeGreaterThan(0);
        expect(proposal.confidence).toBeGreaterThan(0);
      }
      // Direct session path: YOLOv8 raw output for the provider to decode.
      const tensor = await letterboxToTensor(png, 1024, 1024);
      const raw = await session.detect({
        data: tensor.data,
        width: tensor.width,
        height: tensor.height,
        scale: tensor.scale,
        padX: tensor.padX,
        padY: tensor.padY,
        originalWidth: size,
        originalHeight: size,
      });
      expect(raw.kind).toBe('yolov8');
    },
    120_000,
  );

  it.runIf(hasYolo && hasOrt && !hasBubbleDetector)(
    'loads YOLOv10n ONNX and proposes bubble boxes on a synthetic page',
    async () => {
      const { loadYoloOnnxSession } = await import(
        '../../apps/api/src/onnx-models.js'
      );
      const { YoloBubbleProposalProvider, letterboxToTensor } = await import(
        '../../packages/bubble-engine/src/ml-bubble-detector.js'
      );
      const sharp = (await import('sharp')).default;

      const size = 200;
      const png = new Uint8Array(
        await sharp({
          create: {
            width: size,
            height: size,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
                   <rect x="50" y="50" width="100" height="100" rx="30"
                         fill="#f5f5f5" stroke="#111" stroke-width="6"/>
                 </svg>`,
              ),
            },
          ])
          .png()
          .toBuffer(),
      );

      const session = await loadYoloOnnxSession({
        modelPath: yoloModelPath,
        format: 'yolov10',
        numClasses: 80,
      });
      expect(session.name).toContain('yolo-onnx');

      const space = {
        id: 'image:onnx-yolo' as never,
        kind: 'image' as const,
        dimensions: { width: size, height: size },
      };
      const provider = new YoloBubbleProposalProvider({
        session,
        confidenceThreshold: 0.05,
        bubbleClassesOnly: false,
        maximumProposals: 16,
      });
      const proposals = await provider.propose(png, space);
      expect(Array.isArray(proposals)).toBe(true);
      // YOLOv10n is a general detector; any proposal shape is valid output.
      for (const proposal of proposals) {
        expect(proposal.provenance).toBe('ml');
        expect(proposal.boundingBox.width).toBeGreaterThan(0);
        expect(proposal.boundingBox.height).toBeGreaterThan(0);
        expect(proposal.confidence).toBeGreaterThan(0);
      }
      // Direct session path also works.
      const tensor = await letterboxToTensor(png, 640, 640);
      const raw = await session.detect({
        data: tensor.data,
        width: tensor.width,
        height: tensor.height,
        scale: tensor.scale,
        padX: tensor.padX,
        padY: tensor.padY,
        originalWidth: size,
        originalHeight: size,
      });
      expect(raw.kind).toBe('detections');
    },
    60_000,
  );

  it.runIf(hasWav2vec && hasOrt)(
    'loads wav2vec2 CTC ONNX and emits frame posteriors for forced alignment',
    async () => {
      const { loadWav2vec2CtcProvider, hashModelFile } = await import(
        '../../apps/api/src/onnx-models.js'
      );
      const { alignWordsAcoustic } = await import(
        '../../packages/audio-engine/src/wav2vec2-alignment.js'
      );

      const provider = await loadWav2vec2CtcProvider({
        modelPath: wav2vecModelPath,
      });
      expect(provider.name).toContain('wav2vec2');

      // 0.4s of low-level noise as a stand-in waveform (model still runs).
      const sampleRateHz = 16_000;
      const pcm = new Float32Array(sampleRateHz * 2);
      for (let i = 0; i < pcm.length; i += 1) {
        pcm[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRateHz) * 0.15;
      }

      const result = await alignWordsAcoustic({
        segments: [
          {
            id: 'seg-real',
            text: 'hello world',
            interval: {
              start: {
                value: 0,
                timebase: 'audio:onnx' as never,
                unit: 'seconds',
              },
              end: {
                value: 1.5,
                timebase: 'audio:onnx' as never,
                unit: 'seconds',
              },
            },
          },
        ],
        timebase: {
          id: 'audio:onnx' as never,
          unit: 'seconds',
        },
        pcm,
        sampleRateHz,
        provider,
      });

      expect(result.algorithm).toBe('ctc-viterbi');
      expect(result.provider).toContain('wav2vec2');
      expect(result.words).toHaveLength(2);
      expect(result.words.map((w) => w.text)).toEqual(['hello', 'world']);
      expect(result.words[0]!.start.value).toBeLessThan(result.words[0]!.end.value);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.framesPerSegment[0]).toBeGreaterThan(0);

      const hash = await hashModelFile(wav2vecModelPath);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    },
    120_000,
  );

  it.runIf(!hasOrt)(
    'onnxruntime-node is not installed in this environment',
    () => {
      console.warn('onnxruntime-node unavailable; real-weight tests skipped');
      expect(hasOrt).toBe(false);
    },
  );
});
