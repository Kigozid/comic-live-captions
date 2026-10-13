import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { BUBBLE_DETECTOR_CLASSES } from '@comic-captioner/bubble-engine';

/**
 * Real ONNX model loaders for comic captioning:
 * - YOLO bubble proposals (`YoloInferenceSession`)
 * - wav2vec2 CTC frame posteriors (`CtcFramePosteriorsProvider`)
 *
 * `onnxruntime-node` is loaded dynamically so environments without the
 * optional native binding still start. Model weights live under `models/`
 * (gitignored); download with `pnpm models:fetch`.
 */

export class OnnxModelError extends Error {
  constructor(
    readonly code:
      | 'RUNTIME_MISSING'
      | 'MODEL_MISSING'
      | 'MODEL_LOAD_FAILED'
      | 'INVALID_OUTPUT',
    message: string,
  ) {
    super(message);
    this.name = 'OnnxModelError';
  }
}

const DEFAULT_MODELS_DIR = resolve(process.cwd(), 'models');

export interface OrtTensorLike {
  readonly data: Float32Array | Int32Array | BigInt64Array | Uint8Array;
  readonly dims: readonly number[];
  readonly type: string;
}

export interface OrtSessionLike {
  readonly inputNames?: readonly string[];
  readonly outputNames?: readonly string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}

async function loadOrt(): Promise<{
  InferenceSession: {
    create(
      path: string,
      options?: Record<string, unknown>,
    ): Promise<OrtSessionLike>;
  };
  Tensor: new (
    type: string,
    data: Float32Array | Int32Array | BigInt64Array | Uint8Array,
    dims: readonly number[],
  ) => OrtTensorLike;
}> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ort = (await import('onnxruntime-node')) as any;
    return ort;
  } catch (cause) {
    throw new OnnxModelError(
      'RUNTIME_MISSING',
      `onnxruntime-node is not available: ${cause instanceof Error ? cause.message : 'unknown error'}. Install it with: pnpm --filter @comic-captioner/api add onnxruntime-node`,
    );
  }
}

async function assertModelFile(path: string): Promise<string> {
  const modelPath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    await access(modelPath, fsConstants.R_OK);
    return modelPath;
  } catch {
    throw new OnnxModelError(
      'MODEL_MISSING',
      `ONNX model not found at ${modelPath}. Download weights with \`pnpm models:fetch\` or point COMIC_YOLO_MODEL / COMIC_WAV2VEC_MODEL at an .onnx file.`,
    );
  }
}

// ---------------------------------------------------------------------------
// YOLO bubble proposals
// ---------------------------------------------------------------------------

export interface LoadYoloOnnxOptions {
  readonly modelPath?: string;
  readonly inputName?: string;
  readonly outputName?: string;
  readonly inputWidth?: number;
  readonly inputHeight?: number;
  readonly format?: 'yolov5' | 'yolov8' | 'yolov10';
  readonly numClasses?: number;
  readonly name?: string;
}

/**
 * Load a YOLO ONNX detector as a `YoloInferenceSession`. YOLOv10 output is
 * already NMS-free end-to-end (detections); v5/v8 are decoded by the
 * bubble-engine port.
 *
 * Default weights are the trained comic speech-bubble detector
 * (YOLOv8, 2 classes at 1024²). Fall back to generic YOLOv10n if absent.
 */
export async function loadYoloOnnxSession(
  options: LoadYoloOnnxOptions = {},
): Promise<import('@comic-captioner/bubble-engine').YoloInferenceSession> {
  const preferredModel =
    options.modelPath ??
    process.env.COMIC_YOLO_MODEL ??
    join(
      DEFAULT_MODELS_DIR,
      'bubble-yolo',
      'comic-speech-bubble-detector.onnx',
    );
  const fallbackModel = join(DEFAULT_MODELS_DIR, 'bubble-yolo', 'model.onnx');
  let modelPath: string;
  try {
    modelPath = await assertModelFile(preferredModel);
  } catch (error) {
    if (options.modelPath || process.env.COMIC_YOLO_MODEL) throw error;
    modelPath = await assertModelFile(fallbackModel);
  }

  const isBubbleDetector = modelPath.includes('comic-speech-bubble-detector');
  const ort = await loadOrt();
  let session: OrtSessionLike;
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });
  } catch (cause) {
    throw new OnnxModelError(
      'MODEL_LOAD_FAILED',
      `Failed to load YOLO model ${modelPath}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  const inputWidth = options.inputWidth ?? (isBubbleDetector ? 1024 : 640);
  const inputHeight = options.inputHeight ?? (isBubbleDetector ? 1024 : 640);
  const format = options.format ?? (isBubbleDetector ? 'yolov8' : 'yolov10');
  const numClasses = options.numClasses ?? (isBubbleDetector ? 2 : 80);
  const inputName = options.inputName ?? session.inputNames?.[0] ?? 'images';
  const outputName = options.outputName ?? session.outputNames?.[0] ?? 'output0';
  const name = options.name ?? `yolo-onnx:${modelPath}`;

  return {
    name,
    inputWidth,
    inputHeight,
    /** Present when this is the trained comic speech-bubble detector. */
    ...(isBubbleDetector ? { classLabels: BUBBLE_DETECTOR_CLASSES } : {}),
    async detect(input) {
      const tensor = new ort.Tensor('float32', input.data, [
        1,
        3,
        input.height,
        input.width,
      ]);
      const results = await session.run({ [inputName]: tensor });
      const output = results[outputName] ?? results[Object.keys(results)[0]!];
      if (!output) {
        throw new OnnxModelError('INVALID_OUTPUT', 'YOLO model returned no tensor.');
      }
      const data = output.data as Float32Array;
      // YOLOv10 / v8 export: [1, N, 4+C] or [1, N, 6] with cx,cy,w,h,score,class
      // YOLOv5 export: [1, N, 5+C]
      if (format === 'yolov10') {
        return decodeYolov10Detections(data, input);
      }
      const numDetections =
        format === 'yolov5'
          ? Math.floor(data.length / (5 + numClasses))
          : Math.floor(data.length / (4 + numClasses));
      return {
        kind: format === 'yolov5' ? 'yolov5' : 'yolov8',
        output: data,
        numDetections,
        numClasses,
      };
    },
  };
}

function decodeYolov10Detections(
  data: Float32Array,
  input: {
    readonly scale: number;
    readonly padX: number;
    readonly padY: number;
  },
):
  | {
      readonly kind: 'detections';
      readonly detections: readonly {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        confidence: number;
        classId: number;
        classLabel?: string;
      }[];
    } {
  // Layout [1, N, 6]: x1,y1,x2,y2,score,class  (YOLOv10)
  // or [1, N, 5+C] starting with cx,cy,w,h,score
  const detections: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    confidence: number;
    classId: number;
  }[] = [];
  const stride = data.length % 6 === 0 ? 6 : 5 + 80;
  const count = Math.floor(data.length / stride);
  for (let i = 0; i < count; i += 1) {
    const base = i * stride;
    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    let confidence: number;
    let classId: number;
    if (stride === 6) {
      x1 = data[base]!;
      y1 = data[base + 1]!;
      x2 = data[base + 2]!;
      y2 = data[base + 3]!;
      confidence = data[base + 4]!;
      classId = data[base + 5]!;
    } else {
      const cx = data[base]!;
      const cy = data[base + 1]!;
      const w = data[base + 2]!;
      const h = data[base + 3]!;
      confidence = data[base + 4]!;
      classId = 0;
      for (let c = 1; c < stride - 4; c += 1) {
        if (data[base + 4 + c]! > confidence) {
          classId = c - 1;
          confidence = data[base + 4 + c]!;
        }
      }
      x1 = cx - w / 2;
      y1 = cy - h / 2;
      x2 = cx + w / 2;
      y2 = cy + h / 2;
    }
    if (confidence < 0.05) continue;
    // Reverse letterbox.
    detections.push({
      x1: (x1 - input.padX) / input.scale,
      y1: (y1 - input.padY) / input.scale,
      x2: (x2 - input.padX) / input.scale,
      y2: (y2 - input.padY) / input.scale,
      confidence,
      classId,
    });
  }
  return { kind: 'detections', detections };
}

// ---------------------------------------------------------------------------
// wav2vec2 CTC frame posteriors
// ---------------------------------------------------------------------------

/** wav2vec2-base-960h CTC vocabulary (Xenova / Hugging Face export). */
export const WAV2VEC2_BASE_VOCAB = [
  '<pad>',
  '<s>',
  '</s>',
  '<unk>',
  '|',
  ...'abcdefghijklmnopqrstuvwxyz',
] as const;

export interface LoadWav2vec2Options {
  readonly modelPath?: string;
  readonly inputName?: string;
  readonly outputName?: string;
  readonly vocab?: readonly string[];
  readonly frameShiftSeconds?: number;
  readonly name?: string;
}

/**
 * Load wav2vec2 CTC ONNX weights as a `CtcFramePosteriorsProvider`.
 * Input: raw waveform `input_values` [1, T]. Output: `logits` [1, T', V].
 */
export async function loadWav2vec2CtcProvider(
  options: LoadWav2vec2Options = {},
): Promise<
  import('@comic-captioner/audio-engine').CtcFramePosteriorsProvider
> {
  const modelPath = await assertModelFile(
    options.modelPath ??
      process.env.COMIC_WAV2VEC_MODEL ??
      join(DEFAULT_MODELS_DIR, 'wav2vec2', 'model_quantized.onnx'),
  );
  const ort = await loadOrt();
  let session: OrtSessionLike;
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });
  } catch (cause) {
    throw new OnnxModelError(
      'MODEL_LOAD_FAILED',
      `Failed to load wav2vec2 model ${modelPath}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  const vocab = options.vocab ?? WAV2VEC2_BASE_VOCAB;
  const frameShiftSeconds = options.frameShiftSeconds ?? 0.02;
  const inputName = options.inputName ?? session.inputNames?.[0] ?? 'input_values';
  const outputName = options.outputName ?? session.outputNames?.[0] ?? 'logits';
  const name = options.name ?? `wav2vec2:${modelPath}`;

  return {
    name,
    async encode(input) {
      if (input.pcm.length === 0) {
        throw new OnnxModelError('INVALID_OUTPUT', 'PCM slice is empty.');
      }
      const waveform = new ort.Tensor('float32', input.pcm, [1, input.pcm.length]);
      const results = await session.run({ [inputName]: waveform });
      const output = results[outputName] ?? results[Object.keys(results)[0]!];
      if (!output) {
        throw new OnnxModelError(
          'INVALID_OUTPUT',
          'wav2vec2 model returned no logits tensor.',
        );
      }
      const logits = output.data as Float32Array;
      const dims = output.dims;
      // Expected [1, time, vocab] or [time, vocab]
      const numFrames =
        dims.length === 3 ? (dims[1] as number) : (dims[0] as number);
      const numTokens =
        dims.length === 3 ? (dims[2] as number) : (dims[1] as number);
      if (!numFrames || !numTokens || logits.length < numFrames * numTokens) {
        throw new OnnxModelError(
          'INVALID_OUTPUT',
          `Unexpected wav2vec2 logits shape ${JSON.stringify(dims)}.`,
        );
      }

      // Log-softmax over vocab → log posteriors for Viterbi.
      const logProbs = new Float32Array(numFrames * numTokens);
      for (let frame = 0; frame < numFrames; frame += 1) {
        let max = Number.NEGATIVE_INFINITY;
        for (let v = 0; v < numTokens; v += 1) {
          const value = logits[frame * numTokens + v]!;
          if (value > max) max = value;
        }
        let sum = 0;
        for (let v = 0; v < numTokens; v += 1) {
          sum += Math.exp(logits[frame * numTokens + v]! - max);
        }
        const logSum = Math.log(sum) + max;
        for (let v = 0; v < numTokens; v += 1) {
          logProbs[frame * numTokens + v] = logits[frame * numTokens + v]! - logSum;
        }
      }

      // Map model vocab to the alignment alphabet used by tokenizeWords:
      // '' blank, ' ', a-z, 0-9, "'", '-'
      // wav2vec2 vocab: <pad>=blank, |=space, a-z, rest rare.
      const alignmentTokens = [
        '',
        ' ',
        ...'abcdefghijklmnopqrstuvwxyz',
        ...'0123456789',
        "'",
        '-',
      ];
      const mapped = new Float32Array(numFrames * alignmentTokens.length);
      mapped.fill(Math.log(1e-8));
      const vocabIndex = new Map(
        vocab.map((token, index) => [token, index] as const),
      );
      for (const [alignIndex, token] of alignmentTokens.entries()) {
        let sourceIndex: number | undefined;
        if (token === '') sourceIndex = vocabIndex.get('<pad>') ?? 0;
        else if (token === ' ') sourceIndex = vocabIndex.get('|') ?? 4;
        else sourceIndex = vocabIndex.get(token);
        if (sourceIndex === undefined) continue;
        for (let frame = 0; frame < numFrames; frame += 1) {
          mapped[frame * alignmentTokens.length + alignIndex] =
            logProbs[frame * numTokens + sourceIndex]!;
        }
      }

      return {
        logProbs: mapped,
        numFrames,
        numTokens: alignmentTokens.length,
        tokens: alignmentTokens,
        frameShiftSeconds,
        isLogScale: true,
        blankIndex: 0,
      };
    },
  };
}

/** SHA-256 of model bytes for provenance (optional integrity check). */
export async function hashModelFile(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const bytes = await readFile(await assertModelFile(path));
  return createHash('sha256').update(bytes).digest('hex');
}
