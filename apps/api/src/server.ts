import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  dimensionsMatch,
  AlignmentError,
  ImageAlignmentEngine,
  ImmutableSourceImage,
  MAX_SOURCE_IMAGE_BYTES,
  SourceImageImportError,
  applyManualAlignment,
  renderAlignedCleanedImage,
  renderAlignmentVisualizations,
  parseOCRDocument,
  TextDifferenceEngine,
  type AlignmentResult,
  type TextDifferenceResult,
  type SourceImageRole,
} from '@comic-captioner/image-engine';
import {
  AssistError,
  DialogueMappingEngine,
  GeminiAssistProvider,
  GeminiAssistService,
  GeminiTranscriptionError,
  GeminiTranscriptionProvider,
  type AssistInput,
} from '@comic-captioner/ai';
import type { BubbleDialogueReference } from '@comic-captioner/core';
import {
  BubbleDetectionEngine,
  BubbleDialogueAssociationEngine,
  CaptionSafeRegionEngine,
  HybridBubbleDetector,
  YoloBubbleProposalProvider,
  type HybridBubble,
  type HybridBubbleDetectionResult,
} from '@comic-captioner/bubble-engine';
import {
  OnnxModelError,
  loadWav2vec2CtcProvider,
  loadYoloOnnxSession,
} from './onnx-models.js';
import {
  AudioPcmError,
  decodeAudioToPcm,
} from './audio-pcm.js';
import {
  ForcedAlignAcousticError,
  OfflineTranscriptionProvider,
  alignWordsAcoustic,
  type CtcFramePosteriorsProvider,
  type TranscriptionProvider,
} from '@comic-captioner/audio-engine';
import { WhisperTranscriptionProvider } from './whisper-transcription.js';
import {
  createFasterWhisperProviderFromEnv,
} from './faster-whisper.js';
import type {
  ImageSpace,
  OCRLine,
  OriginalTextRegion,
} from '@comic-captioner/shared';
import { createImageSpace, createMaskSpace } from '@comic-captioner/shared';
import {
  CaptionFittingEngine,
  type CaptionFontMetrics,
} from '@comic-captioner/caption-engine';
import {
  TranscriptionError,
  TranscriptionService,
  type AudioAssetMetadata,
  type TranscriptSegment,
} from '@comic-captioner/audio-engine';
import { createHash } from 'node:crypto';
import { scanWithLocalOCR, type OCRBubbleInput } from './local-ocr.js';
import {
  FfmpegExportError,
  checkFfmpegAvailability,
  runExportJob,
  type ExportRequestBody,
} from './export.js';
import {
  VideoExportError,
  cancelVideoExportJob,
  checkVideoExportAvailability,
  createVideoExportJob,
  getVideoExportJob,
  listVideoExportJobs,
  readVideoExportArtifact,
  type VideoExportRequest,
} from './remotion-export.js';
import {
  PageDetectionCoordinator,
  PageDetectionError,
} from './page-detection.js';
import {
  CleanPageCoordinator,
  CleanPageError,
} from './clean-page.js';
import { createLamaProviderFromEnv } from './lama-provider.js';
import type { LetteringSourceRegion } from '@comic-captioner/image-engine';

const serviceName = 'comic-captioner-api';

/**
 * ASR preference: faster-whisper (local Python) → whisper (transformers.js)
 * → gemini → offline stub.
 * Override with COMIC_ASR=faster-whisper|whisper|gemini|offline.
 * Model: COMIC_WHISPER_MODEL (default small). Service: COMIC_WHISPER_URL.
 */
function resolveTranscriptionProviderId(): string {
  const forced = process.env.COMIC_ASR ?? process.env.COMIC_TRANSCRIPTION_PROVIDER;
  if (forced === 'offline') return 'offline-stub';
  if (forced === 'gemini') return 'gemini';
  if (forced === 'whisper') return 'whisper';
  if (forced === 'faster-whisper' || forced === 'faster_whisper')
    return 'faster-whisper';
  // Default local path: faster-whisper (CPU INT8 small model).
  return 'faster-whisper';
}

function createTranscriptionProvider(): TranscriptionProvider {
  const id = resolveTranscriptionProviderId();
  if (id === 'gemini') return new GeminiTranscriptionProvider();
  if (id === 'whisper') return new WhisperTranscriptionProvider();
  if (id === 'faster-whisper') return createFasterWhisperProviderFromEnv();
  return new OfflineTranscriptionProvider();
}

/** OCR engine: trocr (stronger) → paddle. Override with COMIC_OCR_ENGINE. */
function resolveOcrEngineId(): string {
  const forced = process.env.COMIC_OCR_ENGINE;
  if (forced === 'paddle' || forced === 'trocr') return forced;
  return 'trocr';
}

const alignmentEngine = new ImageAlignmentEngine();
const textDifferenceEngine = new TextDifferenceEngine();
const bubbleDetectionEngine = new BubbleDetectionEngine();
const bubbleAssociationEngine = new BubbleDialogueAssociationEngine();
const safeRegionEngine = new CaptionSafeRegionEngine();
const captionFittingEngine = new CaptionFittingEngine();
/** Comic-aware page detection: bubbles + text regions + OCR association. */
const pageDetectionCoordinator = new PageDetectionCoordinator({
  recognizeOcr: async (image, space) => {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(image).metadata();
    const sha256 = createHash('sha256').update(image).digest('hex');
    const result = await scanWithLocalOCR(image, {
      id: `detect-page-${sha256.slice(0, 12)}`,
      role: 'original',
      filename: 'detect-page',
      format: meta.format === 'jpeg' ? 'JPEG' : meta.format === 'webp' ? 'WEBP' : 'PNG',
      mediaType:
        meta.format === 'jpeg'
          ? 'image/jpeg'
          : meta.format === 'webp'
            ? 'image/webp'
            : 'image/png',
      dimensions: {
        width: space.dimensions.width,
        height: space.dimensions.height,
      },
      sizeBytes: image.byteLength,
      sha256,
    });
    return result.document;
  },
});
/** Lettering removal / clean-page generation (server-side, sequential). */
const cleanPageCoordinator = new CleanPageCoordinator({
  generative: createLamaProviderFromEnv(),
});
/** Lazily cached ONNX sessions (YOLO proposals + wav2vec2 CTC). */
let yoloSessionPromise: Promise<unknown> | null = null;
let wav2vecProviderPromise: Promise<unknown> | null = null;
const paddleModelUrlByRoute = {
  '/api/ocr-models/detection':
    'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar',
  '/api/ocr-models/recognition':
    'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
} as const;
const paddleModelCache = new Map<string, Promise<Buffer>>();

interface ApiState {
  readonly sourceImages: Map<SourceImageRole, ImmutableSourceImage>;
  alignment: AlignmentResult | null;
  visualizations: {
    readonly overlayPng: Buffer;
    readonly differencePng: Buffer;
  } | null;
  textDifferences: TextDifferenceResult | null;
  /** Test injection for acoustic forced alignment (skips ONNX load). */
  readonly ctcProviderOverride?: CtcFramePosteriorsProvider;
}

class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function currentPair(sourceImages: Map<SourceImageRole, ImmutableSourceImage>) {
  const original = sourceImages.get('original')?.metadata ?? null;
  const cleaned = sourceImages.get('cleaned')?.metadata ?? null;
  return {
    original,
    cleaned,
    dimensionsMatch: dimensionsMatch(original, cleaned),
  };
}

async function readMultipartImage(request: IncomingMessage) {
  const contentType = request.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(
    /\bboundary=(?:"([^"]+)"|([^;\s]+))/i,
  );
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (
    !contentType.toLowerCase().startsWith('multipart/form-data') ||
    !boundary ||
    boundary.length > 70 ||
    /[\r\n]/.test(boundary)
  ) {
    throw new RequestError(
      400,
      'INVALID_MULTIPART',
      'Send an image as multipart form data.',
    );
  }

  const chunks: Buffer[] = [];
  let bodySize = 0;
  const maximumBodyBytes = MAX_SOURCE_IMAGE_BYTES + 256 * 1024;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodySize += bytes.byteLength;
    if (bodySize > maximumBodyBytes) {
      throw new RequestError(
        413,
        'FILE_TOO_LARGE',
        'Image files must be 50 MiB or smaller.',
      );
    }
    chunks.push(bytes);
  }

  const body = Buffer.concat(chunks);
  const opening = Buffer.from(`--${boundary}\r\n`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const partBoundary = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, opening.length).equals(opening)) {
    throw new RequestError(
      400,
      'INVALID_MULTIPART',
      'The upload form could not be read.',
    );
  }

  const headersStart = opening.length;
  const headersEnd = body.indexOf(headerSeparator, headersStart);
  if (headersEnd < 0) {
    throw new RequestError(
      400,
      'INVALID_MULTIPART',
      'The upload form could not be read.',
    );
  }
  const headers = body.toString('latin1', headersStart, headersEnd);
  const disposition = headers.match(
    /^content-disposition:\s*form-data;([^\r\n]+)$/im,
  )?.[1];
  const fieldName = disposition?.match(/\bname="([^"]+)"/i)?.[1];
  const filename = disposition?.match(/\bfilename="([^"]*)"/i)?.[1];
  if (fieldName !== 'image' || !filename) {
    throw new RequestError(
      400,
      'IMAGE_REQUIRED',
      'Upload exactly one file in the image field.',
    );
  }

  const fileStart = headersEnd + headerSeparator.length;
  const fileEnd = body.indexOf(partBoundary, fileStart);
  if (fileEnd < 0) {
    throw new RequestError(
      400,
      'INVALID_MULTIPART',
      'The upload form could not be read.',
    );
  }
  const nextBoundaryStart = fileEnd + partBoundary.length;
  const closingTail = body.subarray(nextBoundaryStart);
  if (
    !closingTail.equals(Buffer.from('--')) &&
    !closingTail.equals(Buffer.from('--\r\n'))
  ) {
    throw new RequestError(
      400,
      'INVALID_MULTIPART',
      'Upload exactly one image file.',
    );
  }

  const bytes = body.subarray(fileStart, fileEnd);
  if (bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new RequestError(
      413,
      'FILE_TOO_LARGE',
      'Image files must be 50 MiB or smaller.',
    );
  }
  return { filename, bytes: Buffer.from(bytes) };
}

async function readMultipartAudio(request: IncomingMessage) {
  const contentType = request.headers['content-type'] ?? '';
  const boundary =
    contentType.match(/\bboundary=(?:"([^"]+)"|([^;\s]+))/i)?.[1] ??
    contentType.match(/\bboundary=(?:"([^"]+)"|([^;\s]+))/i)?.[2];
  if (
    !contentType.toLowerCase().startsWith('multipart/form-data') ||
    !boundary ||
    boundary.length > 70 ||
    /[\r\n]/.test(boundary)
  )
    throw new RequestError(
      400,
      'INVALID_MULTIPART',
      'Send an audio file and its metadata as multipart form data.',
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 201 * 1024 * 1024)
      throw new RequestError(
        413,
        'FILE_TOO_LARGE',
        'Audio files must be 200 MiB or smaller.',
      );
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  let cursor = marker.length + 2;
  let audio: { filename: string; mimeType: string; bytes: Buffer } | null =
    null;
  let metadataText: string | null = null;
  while (cursor < body.length) {
    const headerEnd = body.indexOf(separator, cursor);
    if (headerEnd < 0)
      throw new RequestError(
        400,
        'INVALID_MULTIPART',
        'Audio upload headers are malformed.',
      );
    const headers = body.toString('latin1', cursor, headerEnd);
    const disposition =
      headers.match(/^content-disposition:\s*form-data;([^\r\n]+)$/im)?.[1] ??
      '';
    const field = disposition.match(/\bname="([^"]+)"/i)?.[1];
    const filename = disposition.match(/\bfilename="([^"]*)"/i)?.[1];
    const mimeType =
      headers
        .match(/^content-type:\s*([^\r\n;]+)/im)?.[1]
        ?.trim()
        .toLowerCase() ?? 'application/octet-stream';
    const valueStart = headerEnd + separator.length;
    const nextPart = body.indexOf(Buffer.from(`\r\n--${boundary}`), valueStart);
    if (nextPart < 0)
      throw new RequestError(
        400,
        'INVALID_MULTIPART',
        'Audio upload body is malformed.',
      );
    const value = body.subarray(valueStart, nextPart);
    if (field === 'audio' && filename && !audio)
      audio = { filename, mimeType, bytes: Buffer.from(value) };
    else if (field === 'metadata' && !filename && metadataText === null)
      metadataText = value.toString('utf8');
    else
      throw new RequestError(
        400,
        'INVALID_MULTIPART',
        'Include exactly one audio file and one metadata field.',
      );
    cursor = nextPart + 2 + marker.length;
    const ending = body.subarray(cursor, cursor + 2).toString('latin1');
    if (ending === '--') break;
    if (ending !== '\r\n')
      throw new RequestError(
        400,
        'INVALID_MULTIPART',
        'Audio upload boundary is malformed.',
      );
    cursor += 2;
  }
  if (!audio || !metadataText)
    throw new RequestError(
      400,
      'AUDIO_REQUIRED',
      'Include one audio file and its metadata.',
    );
  if (audio.bytes.byteLength === 0)
    throw new RequestError(400, 'EMPTY_FILE', 'Choose a non-empty audio file.');
  let value: unknown;
  try {
    value = JSON.parse(metadataText) as unknown;
  } catch {
    throw new RequestError(
      400,
      'INVALID_AUDIO_METADATA',
      'Audio metadata must be valid JSON.',
    );
  }
  const asset = validateAudioMetadata(value, audio);
  if (createHash('sha256').update(audio.bytes).digest('hex') !== asset.sha256)
    throw new RequestError(
      422,
      'AUDIO_HASH_MISMATCH',
      'Uploaded audio does not match the imported asset hash.',
    );
  return { audio, asset };
}

function validateAudioMetadata(
  value: unknown,
  audio: { filename: string; mimeType: string; bytes: Buffer },
): AudioAssetMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RequestError(
      400,
      'INVALID_AUDIO_METADATA',
      'Audio metadata must be an object.',
    );
  const candidate = value as Record<string, unknown>;
  const formats = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'webm'] as const;
  const format = candidate.format;
  if (
    typeof candidate.id !== 'string' ||
    !/^audio-[a-f\d]{20}$/i.test(candidate.id) ||
    candidate.filename !== audio.filename ||
    typeof format !== 'string' ||
    !formats.includes(format as (typeof formats)[number]) ||
    candidate.sizeBytes !== audio.bytes.byteLength ||
    typeof candidate.sha256 !== 'string' ||
    !/^[a-f\d]{64}$/i.test(candidate.sha256) ||
    typeof candidate.durationSeconds !== 'number' ||
    !Number.isFinite(candidate.durationSeconds) ||
    candidate.durationSeconds <= 0 ||
    candidate.durationSeconds > 30 * 60 ||
    typeof candidate.sampleRateHz !== 'number' ||
    !Number.isInteger(candidate.sampleRateHz) ||
    candidate.sampleRateHz < 8000 ||
    candidate.sampleRateHz > 384000 ||
    typeof candidate.channelCount !== 'number' ||
    !Number.isInteger(candidate.channelCount) ||
    candidate.channelCount < 1 ||
    candidate.channelCount > 32
  )
    throw new RequestError(
      400,
      'INVALID_AUDIO_METADATA',
      'Audio metadata is missing valid identity, format, duration, size, rate, or channel values.',
    );
  const timebase = candidate.timebase;
  if (
    !timebase ||
    typeof timebase !== 'object' ||
    (timebase as Record<string, unknown>).id !== `audio:${candidate.id}` ||
    (timebase as Record<string, unknown>).unit !== 'seconds'
  )
    throw new RequestError(
      400,
      'INVALID_AUDIO_TIMEBASE',
      'Audio timebase must identify this asset and use seconds.',
    );
  const mediaTypes: Record<string, string[]> = {
    mp3: ['audio/mpeg', 'audio/mp3'],
    wav: ['audio/wav', 'audio/x-wav'],
    m4a: ['audio/mp4', 'audio/m4a', 'audio/x-m4a'],
    aac: ['audio/aac', 'audio/aacp'],
    ogg: ['audio/ogg', 'application/ogg'],
    webm: ['audio/webm'],
  };
  if (
    format !== audio.filename.toLowerCase().split('.').at(-1) ||
    !mediaTypes[format]?.includes(audio.mimeType)
  )
    throw new RequestError(
      415,
      'UNSUPPORTED_AUDIO_FORMAT',
      'Filename, media type, and audio format must match a supported format.',
    );
  return {
    id: candidate.id,
    filename: candidate.filename as string,
    format: format as AudioAssetMetadata['format'],
    mediaType: audio.mimeType,
    sizeBytes: candidate.sizeBytes as number,
    sha256: candidate.sha256 as string,
    durationSeconds: candidate.durationSeconds as number,
    sampleRateHz: candidate.sampleRateHz as number,
    channelCount: candidate.channelCount as number,
    frameCount: Math.round(
      (candidate.durationSeconds as number) *
        (candidate.sampleRateHz as number),
    ),
    timebase: timebase as AudioAssetMetadata['timebase'],
  };
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = 16 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumBytes)
      throw new RequestError(
        413,
        'BODY_TOO_LARGE',
        'The correction request is too large.',
      );
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(
      400,
      'INVALID_JSON',
      'Send a valid JSON request body.',
    );
  }
}

function parseAutomationSegments(value: unknown): TranscriptSegment[] {
  const transcript = asRecord(value);
  const segments = transcript.segments;
  const timebase = asRecord(transcript.timebase);
  if (
    !Array.isArray(segments) ||
    segments.length === 0 ||
    segments.length > 2000 ||
    typeof transcript.durationSeconds !== 'number' ||
    !Number.isFinite(transcript.durationSeconds) ||
    transcript.durationSeconds <= 0 ||
    typeof timebase.id !== 'string' ||
    !timebase.id ||
    timebase.unit !== 'seconds'
  )
    throw new RequestError(
      400,
      'INVALID_TRANSCRIPT',
      'Provide a reviewed transcript with second-based timestamps.',
    );
  let previousStart = -1;
  return segments.map((item, index) => {
    const segment = asRecord(item);
    const interval = asRecord(segment.interval);
    const start = asRecord(interval.start);
    const end = asRecord(interval.end);
    if (
      typeof segment.id !== 'string' ||
      !segment.id ||
      typeof segment.text !== 'string' ||
      !segment.text.trim() ||
      segment.text.length > 4000 ||
      typeof start.value !== 'number' ||
      typeof end.value !== 'number' ||
      !Number.isFinite(start.value) ||
      !Number.isFinite(end.value) ||
      start.value < previousStart ||
      end.value <= start.value ||
      end.value > (transcript.durationSeconds as number) ||
      start.timebase !== timebase.id ||
      end.timebase !== timebase.id ||
      start.unit !== 'seconds' ||
      end.unit !== 'seconds' ||
      (segment.speakerId !== null && typeof segment.speakerId !== 'string')
    )
      throw new RequestError(
        400,
        'INVALID_TRANSCRIPT',
        `Transcript segment ${index + 1} has invalid text, speaker, or timing.`,
      );
    if (
      typeof segment.speakerId === 'string' &&
      !/^[a-zA-Z0-9_-]{1,64}$/.test(segment.speakerId)
    )
      throw new RequestError(
        400,
        'INVALID_TRANSCRIPT',
        `Transcript segment ${index + 1} has an invalid speaker ID.`,
      );
    previousStart = start.value;
    return {
      id: segment.id,
      text: segment.text,
      interval: {
        start: {
          value: start.value,
          timebase:
            timebase.id as TranscriptSegment['interval']['start']['timebase'],
          unit: 'seconds',
        },
        end: {
          value: end.value,
          timebase:
            timebase.id as TranscriptSegment['interval']['end']['timebase'],
          unit: 'seconds',
        },
      },
      speakerId: segment.speakerId as string | null,
      words: [],
      confidence:
        typeof segment.confidence === 'number' &&
        Number.isFinite(segment.confidence) &&
        segment.confidence >= 0 &&
        segment.confidence <= 1
          ? segment.confidence
          : null,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Normalize a detected or hybrid bubble for the analyze-page response. */
function mapDetectedBubble(bubble: {
  readonly id: string;
  readonly kind: string;
  readonly polygon: { readonly points: readonly unknown[] };
  readonly contour?: { readonly points: readonly unknown[] };
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly coordinateSpace?: unknown;
  };
  readonly confidence: number;
  readonly classificationConfidence?: number;
  readonly shape: string;
  readonly coordinateSpace?: { readonly id?: string };
  readonly algorithmVersion?: string;
  readonly tail?: { readonly points: readonly unknown[] } | null;
}): Record<string, unknown> {
  return {
    id: bubble.id,
    kind: bubble.kind,
    shape: bubble.shape,
    polygon: bubble.polygon,
    contour: bubble.contour ?? bubble.polygon,
    boundingBox: bubble.boundingBox ?? null,
    confidence: bubble.confidence,
    classificationConfidence: bubble.classificationConfidence,
    // Deterministic geometry owns final contours; model output is proposals.
    geometryProvenance: 'derived',
    algorithmVersion: bubble.algorithmVersion ?? 'bubble-cv-2',
    coordinateSpaceId: bubble.coordinateSpace?.id ?? null,
    tail: bubble.tail?.points ?? null,
  };
}

/** Hybrid bubble → API shape, including ML/heuristic provenance. */
function mapHybridBubble(entry: HybridBubble): Record<string, unknown> {
  const { bubble, sources, support, quality } = entry;
  const hasModel = support.some((item) => item.provenance === 'ml');
  return {
    ...mapDetectedBubble(bubble),
    geometryProvenance: hasModel ? 'hybrid' : 'derived',
    sources,
    quality,
    support: support.map((item) => ({
      proposalId: item.proposalId,
      provider: item.provider,
      provenance: item.provenance,
      confidence: item.confidence,
      iou: item.iou,
    })),
  };
}

async function loadWav2vec2ProviderOrThrow(
  state?: ApiState,
): Promise<CtcFramePosteriorsProvider> {
  if (state?.ctcProviderOverride) return state.ctcProviderOverride;
  try {
    wav2vecProviderPromise ??= loadWav2vec2CtcProvider();
    return (await wav2vecProviderPromise) as CtcFramePosteriorsProvider;
  } catch (error) {
    wav2vecProviderPromise = null;
    throw error;
  }
}

/**
 * Refine Gemini transcript word timings with wav2vec2 CTC forced alignment.
 * Never fails the transcription: on any acoustic error the original transcript
 * is returned with `acousticAlignment: null`.
 */
async function refineTranscriptWordTimes(
  transcript: {
    readonly segments: readonly {
      readonly id: string;
      readonly text: string;
      readonly speakerId: string | null;
      readonly interval: {
        readonly start: { readonly value: number };
        readonly end: { readonly value: number };
      };
      readonly words: readonly {
        readonly id: string;
        readonly text: string;
        readonly start: { readonly value: number };
        readonly end: { readonly value: number };
        readonly speakerId: string | null;
        readonly confidence: number | null;
      }[];
    }[];
  },
  audioBytes: Uint8Array,
  asset: { readonly timebase: { readonly id: string } },
  signal?: AbortSignal,
  state?: ApiState,
): Promise<{
  readonly transcript: unknown;
  readonly acousticAlignment: {
    readonly algorithm: string;
    readonly provider: string;
    readonly confidence: number;
  } | null;
}> {
  if (signal?.aborted) {
    return { transcript, acousticAlignment: null };
  }
  try {
    const decoded = await decodeAudioToPcm(audioBytes, {
      sampleRateHz: 16_000,
    });
    const provider = await loadWav2vec2ProviderOrThrow(state);
    const alignment = await alignWordsAcoustic({
      segments: transcript.segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        interval: {
          start: {
            value: segment.interval.start.value,
            timebase: asset.timebase.id as never,
            unit: 'seconds' as const,
          },
          end: {
            value: segment.interval.end.value,
            timebase: asset.timebase.id as never,
            unit: 'seconds' as const,
          },
        },
        speakerId: segment.speakerId,
      })),
      timebase: {
        id: asset.timebase.id as never,
        unit: 'seconds',
      },
      pcm: decoded.pcm,
      sampleRateHz: decoded.sampleRateHz,
      provider,
    });

    // Replace segment word arrays with acoustic timings while keeping segment
    // ids/text/speakers from the ASR transcript.
    const wordsBySegment = new Map<string, typeof alignment.words>();
    let cursor = 0;
    for (const segment of transcript.segments) {
      const count = segment.words.length;
      const slice = alignment.words.slice(cursor, cursor + count);
      cursor += count;
      wordsBySegment.set(segment.id, slice);
    }

    const refinedSegments = transcript.segments.map((segment) => {
      const refinedWords = wordsBySegment.get(segment.id) ?? segment.words;
      return {
        ...segment,
        words: refinedWords.map((word, index) => ({
          id: segment.words[index]?.id ?? word.id,
          text: word.text,
          start: {
            value: word.start.value,
            timebase: asset.timebase.id,
            unit: 'seconds',
          },
          end: {
            value: word.end.value,
            timebase: asset.timebase.id,
            unit: 'seconds',
          },
          speakerId: segment.words[index]?.speakerId ?? word.speakerId,
          confidence: word.confidence,
        })),
      };
    });

    return {
      transcript: {
        ...transcript,
        segments: refinedSegments,
        provenance: {
          ...(transcript as { provenance?: Record<string, unknown> }).provenance,
          acoustic: {
            algorithm: alignment.algorithm,
            provider: alignment.provider,
            confidence: alignment.confidence,
          },
        },
      },
      acousticAlignment: {
        algorithm: alignment.algorithm,
        provider: alignment.provider,
        confidence: alignment.confidence,
      },
    };
  } catch {
    // Acoustic refinement is best-effort; keep Gemini timings.
    return { transcript, acousticAlignment: null };
  }
}

function ocrLineRegion(line: OCRLine, space: ImageSpace): OriginalTextRegion {
  const bounds = line.boundingBox;
  const left = Math.max(
    0,
    Math.min(space.dimensions.width - 1, Math.floor(bounds.x)),
  );
  const top = Math.max(
    0,
    Math.min(space.dimensions.height - 1, Math.floor(bounds.y)),
  );
  const maskSpace = createMaskSpace(
    `ocr-line-mask:${line.id}`,
    space,
    space.dimensions.width,
    space.dimensions.height,
  );
  const points = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((point) => ({ ...point, coordinateSpace: space }));
  return {
    id: `text:${line.id}`,
    mask: {
      width: 1,
      height: 1,
      runs: [{ x: 0, y: 0, length: 1 }],
      origin: { x: left, y: top, coordinateSpace: maskSpace },
      coordinateSpace: maskSpace,
    },
    polygon: { points, coordinateSpace: space },
    boundingBox: { ...bounds, coordinateSpace: space },
    confidence: line.confidence,
    coordinateSpace: space,
  };
}

function automationFontMetrics(): CaptionFontMetrics {
  const glyphAdvances: Record<string, number> = {};
  for (const character of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
    glyphAdvances[character] = 'MW@%&'.includes(character)
      ? 850
      : 'ilIftjr'.includes(character)
        ? 330
        : 'mw'.includes(character)
          ? 760
          : 'ABCDEFGHKNOPQRSTUVXYZ'.includes(character)
            ? 680
            : 550;
  }
  for (const character of " .,;:!|'`") glyphAdvances[character] = 280;
  for (const character of '-_()[]{}') glyphAdvances[character] = 420;
  for (const character of '?*+=/') glyphAdvances[character] = 560;
  return {
    family: 'Arial',
    unitsPerEm: 1000,
    ascent: 750,
    descent: 250,
    fallbackAdvance: 560,
    glyphAdvances,
  };
}

function importErrorStatus(error: SourceImageImportError): number {
  switch (error.code) {
    case 'FILE_TOO_LARGE':
    case 'IMAGE_TOO_LARGE':
      return 413;
    case 'UNSUPPORTED_FORMAT':
      return 415;
    case 'CORRUPT_IMAGE':
      return 422;
    case 'EMPTY_FILE':
      return 400;
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ApiState,
) {
  if (
    request.method === 'GET' &&
    Object.hasOwn(paddleModelUrlByRoute, request.url ?? '')
  ) {
    const route = request.url as keyof typeof paddleModelUrlByRoute;
    try {
      let modelPromise = paddleModelCache.get(route);
      if (!modelPromise) {
        modelPromise = fetch(paddleModelUrlByRoute[route]).then(
          async (upstream) => {
            if (!upstream.ok)
              throw new Error(`Paddle model host returned ${upstream.status}.`);
            const bytes = Buffer.from(await upstream.arrayBuffer());
            if (bytes.byteLength < 1024 * 1024)
              throw new Error('The Paddle model download was incomplete.');
            return bytes;
          },
        );
        paddleModelCache.set(route, modelPromise);
        void modelPromise.catch(() => paddleModelCache.delete(route));
      }
      const bytes = await modelPromise;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.byteLength,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      response.end(bytes);
    } catch (error) {
      sendJson(response, 502, {
        error: {
          code: 'OCR_MODEL_UNAVAILABLE',
          message:
            error instanceof Error
              ? `The official PaddleOCR model could not be loaded: ${error.message}`
              : 'The official PaddleOCR model could not be loaded.',
        },
      });
    }
    return;
  }
  const { sourceImages } = state;
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      service: serviceName,
      configuration: {
        geminiTranscriptionConfigured: Boolean(process.env.GEMINI_API_KEY),
        transcriptionProvider: resolveTranscriptionProviderId(),
        ocrEngine: resolveOcrEngineId(),
      },
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/api/export/ffmpeg') {
    try {
      const availability = await checkFfmpegAvailability();
      sendJson(response, 200, { ffmpeg: availability });
    } catch (error) {
      sendJson(response, 500, {
        error: {
          code: 'FFMPEG_PROBE_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Could not probe FFmpeg availability.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/export') {
    try {
      // Base64 page + audio can be large; allow a generous body for export jobs.
      const value = (await readJsonBody(request, 80 * 1024 * 1024)) as Record<
        string,
        unknown
      >;
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.pageImage !== 'string' ||
        typeof value.fps !== 'number' ||
        typeof value.durationSeconds !== 'number' ||
        !Array.isArray(value.captions) ||
        !Array.isArray(value.bubbles)
      ) {
        throw new RequestError(
          400,
          'INVALID_EXPORT_REQUEST',
          'Provide pageImage, fps, durationSeconds, captions, and bubbles for MP4 export.',
        );
      }
      const abortController = new AbortController();
      request.once('aborted', () => abortController.abort());
      const result = await runExportJob(
        value as unknown as ExportRequestBody,
        abortController.signal,
      );
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(result.bytes.byteLength),
        'x-export-codec': result.codec,
        'x-export-frames': String(result.frameCount),
        'x-export-fps': String(result.fps),
        'x-export-duration': String(result.durationSeconds),
        'x-content-type-options': 'nosniff',
      });
      response.end(result.bytes);
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof FfmpegExportError) {
        const status =
          error.code === 'FFMPEG_MISSING'
            ? 503
            : error.code === 'INVALID_INPUT'
              ? 400
              : error.code === 'ABORTED'
                ? 499
                : 502;
        sendJson(response, status, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'EXPORT_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Server-side MP4 export failed.',
        },
      });
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Remotion motion-comic export jobs (explicit create → poll → download).
  // -------------------------------------------------------------------------

  if (request.method === 'GET' && request.url === '/api/video/export') {
    try {
      const availability = await checkVideoExportAvailability();
      sendJson(response, 200, {
        ...availability,
        jobs: listVideoExportJobs(),
      });
    } catch (error) {
      sendJson(response, 500, {
        error: {
          code: 'VIDEO_EXPORT_PROBE_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Could not probe Remotion video export.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/video/export') {
    try {
      const value = (await readJsonBody(request, 80 * 1024 * 1024)) as Record<
        string,
        unknown
      >;
      const job = await createVideoExportJob(
        value as unknown as VideoExportRequest,
      );
      sendJson(response, 202, { job });
    } catch (error) {
      if (error instanceof VideoExportError) {
        const status =
          error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'INVALID_INPUT' || error.code === 'VALIDATION_FAILED'
              ? 400
              : 500;
        sendJson(response, status, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'VIDEO_EXPORT_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Video export job creation failed.',
        },
      });
    }
    return;
  }

  const videoExportJobMatch = /^\/api\/video\/export\/([A-Za-z0-9-]+)$/.exec(
    request.url ?? '',
  );
  if (request.method === 'GET' && videoExportJobMatch) {
    try {
      sendJson(response, 200, { job: getVideoExportJob(videoExportJobMatch[1]!) });
    } catch (error) {
      if (error instanceof VideoExportError) {
        sendJson(response, error.code === 'NOT_FOUND' ? 404 : 500, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'VIDEO_EXPORT_FAILED',
          message: error instanceof Error ? error.message : 'Lookup failed.',
        },
      });
    }
    return;
  }
  if (request.method === 'DELETE' && videoExportJobMatch) {
    try {
      sendJson(response, 200, {
        job: cancelVideoExportJob(videoExportJobMatch[1]!),
      });
    } catch (error) {
      if (error instanceof VideoExportError) {
        sendJson(response, error.code === 'NOT_FOUND' ? 404 : 500, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'VIDEO_EXPORT_FAILED',
          message: error instanceof Error ? error.message : 'Cancel failed.',
        },
      });
    }
    return;
  }

  const videoExportFileMatch =
    /^\/api\/video\/export\/([A-Za-z0-9-]+)\/file$/.exec(request.url ?? '');
  if (request.method === 'GET' && videoExportFileMatch) {
    try {
      const artifact = await readVideoExportArtifact(videoExportFileMatch[1]!);
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(artifact.bytes.byteLength),
        'content-disposition': `attachment; filename="${artifact.fileName}"`,
        'x-content-type-options': 'nosniff',
      });
      response.end(artifact.bytes);
    } catch (error) {
      if (error instanceof VideoExportError) {
        sendJson(response, error.code === 'NOT_FOUND' ? 404 : 500, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'VIDEO_EXPORT_FAILED',
          message:
            error instanceof Error ? error.message : 'Download failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/assist') {
    if (!process.env.GEMINI_API_KEY) {
      sendJson(response, 503, {
        error: {
          code: 'ASSIST_NOT_CONFIGURED',
          message: 'Server-side Gemini Assist is not configured.',
        },
      });
      return;
    }
    try {
      const value = await readJsonBody(request);
      if (!isAssistInput(value))
        throw new RequestError(
          400,
          'INVALID_ASSIST_REQUEST',
          'Provide a supported assistance task, target ID, and context object.',
        );
      const abortController = new AbortController();
      request.once('aborted', () => abortController.abort());
      const proposal = await new GeminiAssistService(
        new GeminiAssistProvider(),
      ).propose(value, abortController.signal);
      sendJson(response, 200, { proposal });
    } catch (error) {
      const status =
        error instanceof RequestError
          ? error.statusCode
          : error instanceof AssistError
            ? 422
            : 502;
      sendJson(response, status, {
        error: {
          code:
            error instanceof RequestError
              ? error.code
              : error instanceof AssistError
                ? 'ASSIST_INVALID'
                : 'GEMINI_FAILED',
          message:
            error instanceof Error ? error.message : 'Gemini Assist failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/transcribe') {
    try {
      const { audio, asset } = await readMultipartAudio(request);
      const controller = new AbortController();
      request.once('aborted', () => controller.abort());
      // faster-whisper / whisper → Gemini → offline stub. COMIC_ASR forces a path.
      let provider = createTranscriptionProvider();
      let transcript;
      try {
        transcript = await new TranscriptionService(provider).transcribe({
          asset,
          bytes: new Uint8Array(
            audio.bytes.buffer,
            audio.bytes.byteOffset,
            audio.bytes.byteLength,
          ),
          signal: controller.signal,
        });
      } catch (cause) {
        const missingModel =
          cause instanceof Error &&
          (cause.name === 'WhisperTranscriptionError' ||
            cause.name === 'FasterWhisperError' ||
            (cause as { code?: string }).code === 'UNAVAILABLE' ||
            (cause as { code?: string }).code === 'MODEL_MISSING' ||
            /MODEL_MISSING|MODEL_LOAD_FAILED|UNAVAILABLE/i.test(cause.message));
        const localDefault =
          resolveTranscriptionProviderId() === 'whisper' ||
          resolveTranscriptionProviderId() === 'faster-whisper';
        if (
          missingModel &&
          localDefault &&
          process.env.COMIC_ASR !== 'whisper' &&
          process.env.COMIC_ASR !== 'faster-whisper' &&
          process.env.COMIC_ASR !== 'faster_whisper'
        ) {
          provider = process.env.GEMINI_API_KEY
            ? new GeminiTranscriptionProvider()
            : new OfflineTranscriptionProvider();
          transcript = await new TranscriptionService(provider).transcribe({
            asset,
            bytes: new Uint8Array(
              audio.bytes.buffer,
              audio.bytes.byteOffset,
              audio.bytes.byteLength,
            ),
            signal: controller.signal,
          });
        } else {
          throw cause;
        }
      }

      // WhisperX-style refinement: wav2vec2 CTC forced alignment of transcript
      // words to acoustic frames. Falls back to provider timings when weights or
      // FFmpeg are unavailable.
      const refined = await refineTranscriptWordTimes(
        transcript,
        new Uint8Array(
          audio.bytes.buffer,
          audio.bytes.byteOffset,
          audio.bytes.byteLength,
        ),
        asset,
        controller.signal,
        state,
      );
      sendJson(response, 200, {
        transcript: refined.transcript,
        acousticAlignment: refined.acousticAlignment,
        provider: provider.providerId,
      });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof TranscriptionError) {
        const status =
          error.code === 'TIMEOUT'
            ? 504
            : error.code === 'INVALID_OUTPUT'
              ? 422
              : error.code === 'ABORTED'
                ? 499
                : 502;
        sendJson(response, status, {
          error: {
            code: error.providerCode ?? error.code,
            message: error.message,
          },
        });
        return;
      }
      if (error instanceof GeminiTranscriptionError) {
        sendJson(response, 502, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'TRANSCRIPTION_FAILED',
          message: 'The audio could not be transcribed.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/detect-bubbles') {
    try {
      const value = asRecord(
        await readJsonBody(request, 50 * 1024 * 1024),
      );
      const imageBase64 =
        typeof value.pageImage === 'string' ? value.pageImage : null;
      if (!imageBase64) {
        throw new RequestError(
          400,
          'INVALID_DETECT_REQUEST',
          'Provide pageImage as base64-encoded PNG/JPEG bytes.',
        );
      }
      const normalized = imageBase64.includes(',')
        ? imageBase64.slice(imageBase64.indexOf(',') + 1)
        : imageBase64;
      const imageBytes = new Uint8Array(Buffer.from(normalized, 'base64'));
      if (imageBytes.byteLength === 0) {
        throw new RequestError(
          400,
          'INVALID_DETECT_REQUEST',
          'pageImage decoded to zero bytes.',
        );
      }
      const width = Number(value.width ?? 0);
      const height = Number(value.height ?? 0);
      // Infer dimensions from the image when not provided.
      let spaceWidth = Number.isFinite(width) && width > 0 ? width : 0;
      let spaceHeight = Number.isFinite(height) && height > 0 ? height : 0;
      if (!spaceWidth || !spaceHeight) {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(imageBytes).metadata();
        spaceWidth = meta.width ?? 0;
        spaceHeight = meta.height ?? 0;
      }
      if (!spaceWidth || !spaceHeight) {
        throw new RequestError(
          400,
          'INVALID_DETECT_REQUEST',
          'Could not determine page dimensions; pass width and height.',
        );
      }
      const coordinateSpace = createImageSpace(
        typeof value.spaceId === 'string' && value.spaceId
          ? value.spaceId
          : `image:detect-${Date.now()}`,
        spaceWidth,
        spaceHeight,
      );

      let detector: HybridBubbleDetector | typeof bubbleDetectionEngine =
        bubbleDetectionEngine;
      let providerName: string | null = null;
      try {
        yoloSessionPromise ??= loadYoloOnnxSession();
        const yoloSession = (await yoloSessionPromise) as ConstructorParameters<
          typeof YoloBubbleProposalProvider
        >[0]['session'] & { classLabels?: readonly string[] };
        providerName = yoloSession.name;
        detector = new HybridBubbleDetector({
          deterministic: bubbleDetectionEngine,
          provider: new YoloBubbleProposalProvider({
            session: yoloSession,
            ...(yoloSession.classLabels
              ? { classLabels: yoloSession.classLabels }
              : {}),
            confidenceThreshold: Number(value.confidenceThreshold ?? 0.25),
            bubbleClassesOnly: value.bubbleClassesOnly !== false,
            maximumProposals: Number(value.maximumProposals ?? 32),
          }),
        });
      } catch (error) {
        if (value.requireYolo === true) {
          throw error;
        }
        detector = bubbleDetectionEngine;
      }

      const detection = await detector.detect(imageBytes, coordinateSpace);
      const isHybrid =
        detection &&
        typeof detection === 'object' &&
        'proposalCount' in detection;
      const bubbles = isHybrid
        ? (detection as HybridBubbleDetectionResult).bubbles.map((entry) =>
            mapHybridBubble(entry),
          )
        : [...(detection as { bubbles: readonly Parameters<typeof mapDetectedBubble>[0][] }).bubbles].map(
            (bubble) => mapDetectedBubble(bubble),
          );

      sendJson(response, 200, {
        coordinateSpace,
        bubbles,
        detection: isHybrid
          ? {
              mode: 'hybrid',
              provider: providerName ? `yolo:${providerName}` : null,
              deterministicCount: (detection as HybridBubbleDetectionResult)
                .deterministicCount,
              proposalCount: (detection as HybridBubbleDetectionResult)
                .proposalCount,
              mergedCount: (detection as HybridBubbleDetectionResult).mergedCount,
              refinedCount: (detection as HybridBubbleDetectionResult).refinedCount,
              rejectedCount: (detection as HybridBubbleDetectionResult)
                .rejectedCount,
            }
          : { mode: 'deterministic', provider: null },
      });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof OnnxModelError) {
        sendJson(response, error.code === 'MODEL_MISSING' ? 503 : 422, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'DETECT_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Bubble detection failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/detect-page') {
    try {
      const value = asRecord(await readJsonBody(request, 50 * 1024 * 1024));
      const imageBase64 =
        typeof value.pageImage === 'string' ? value.pageImage : null;
      if (!imageBase64) {
        throw new RequestError(
          400,
          'INVALID_DETECT_REQUEST',
          'Provide pageImage as base64-encoded PNG/JPEG bytes.',
        );
      }
      const normalized = imageBase64.includes(',')
        ? imageBase64.slice(imageBase64.indexOf(',') + 1)
        : imageBase64;
      const imageBytes = new Uint8Array(Buffer.from(normalized, 'base64'));
      const width = Number(value.width ?? 0);
      const height = Number(value.height ?? 0);
      const includeOcr = value.includeOcr !== false;
      const result = await pageDetectionCoordinator.detect({
        pageImage: imageBytes,
        ...(Number.isFinite(width) && width > 0 ? { width } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
        ...(typeof value.spaceId === 'string' && value.spaceId
          ? { spaceId: value.spaceId }
          : {}),
        ...(typeof value.requestId === 'string' && value.requestId
          ? { requestId: value.requestId }
          : {}),
        includeOcr,
        ...(typeof value.confidenceThreshold === 'number'
          ? { confidenceThreshold: value.confidenceThreshold }
          : {}),
        ...(typeof value.maximumProposals === 'number'
          ? { maximumProposals: value.maximumProposals }
          : {}),
        requireYolo: value.requireYolo === true,
      });
      if (request.aborted || response.destroyed) return;
      sendJson(response, result.status === 'stale' ? 409 : 200, {
        ...result,
        // JSON-safe: freeze() objects serialize as plain values.
        bubbles: result.bubbles.map((bubble) => ({
          ...bubble,
          // Ensure geometry payloads are plain JSON.
          polygon: bubble.polygon,
          contour: bubble.contour,
          boundingBox: bubble.boundingBox,
        })),
        textRegions: result.textRegions,
      });
    } catch (error) {
      if (request.aborted || response.destroyed) return;
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof PageDetectionError) {
        const status =
          error.code === 'INVALID_REQUEST'
            ? 400
            : error.code === 'IMAGE_TOO_LARGE'
              ? 413
              : error.code === 'MODEL_MISSING'
                ? 503
                : 422;
        sendJson(response, status, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'PAGE_DETECTION_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Page detection failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/clean-page') {
    try {
      const value = asRecord(await readJsonBody(request, 50 * 1024 * 1024));
      const imageBase64 =
        typeof value.pageImage === 'string' ? value.pageImage : null;
      if (!imageBase64) {
        throw new RequestError(
          400,
          'INVALID_CLEAN_REQUEST',
          'Provide pageImage as base64-encoded PNG/JPEG or raw RGBA bytes.',
        );
      }
      const normalized = imageBase64.includes(',')
        ? imageBase64.slice(imageBase64.indexOf(',') + 1)
        : imageBase64;
      const encoded = new Uint8Array(Buffer.from(normalized, 'base64'));
      const width = Number(value.width ?? 0);
      const height = Number(value.height ?? 0);
      const raster = await decodeCleanRaster(encoded, width, height);
      const textRegions = parseCleanTextRegions(value.textRegions, raster, spaceIdFrom(value));
      const bubbles = parseCleanBubbles(value.bubbles);
      const manualEdits = parseManualEdits(value.manualEdits, raster.width, raster.height);
      const result = await cleanPageCoordinator.cleanPage({
        image: raster,
        ...(typeof value.spaceId === 'string' && value.spaceId
          ? { spaceId: value.spaceId }
          : {}),
        ...(typeof value.requestId === 'string' && value.requestId
          ? { requestId: value.requestId }
          : {}),
        textRegions,
        bubbles,
        manualEdits,
        ...(value.options && typeof value.options === 'object'
          ? {
              options: {
                ...((value.options as Record<string, unknown>).expansionPx !==
                undefined
                  ? {
                      expansionPx: Number(
                        (value.options as Record<string, unknown>).expansionPx,
                      ),
                    }
                  : {}),
                preferLamaForArtwork:
                  (value.options as Record<string, unknown>)
                    .preferLamaForArtwork !== false,
                erasureScope:
                  (value.options as Record<string, unknown>).erasureScope ===
                  'approved'
                    ? ('approved' as const)
                    : ('bubble-interior' as const),
              },
            }
          : {}),
      });
      if (request.aborted || response.destroyed) return;
      if (result.status === 'stale') {
        sendJson(response, 409, {
          error: {
            code: 'STALE_CLEAN_REQUEST',
            message:
              'A newer cleaning request superseded this one; discard these results.',
          },
          ...result,
        });
        return;
      }
      // Return PNG as base64 plus a JSON-safe summary.
      sendJson(response, 200, {
        requestId: result.requestId,
        status: result.status,
        width: result.width,
        height: result.height,
        cleanedPng: Buffer.from(result.cleanedPng).toString('base64'),
        removalMask: Buffer.from(result.removalMask).toString('base64'),
        regions: result.regions,
        warnings: result.warnings,
        methodSummary: result.methodSummary,
        complete: result.complete,
        lamaAvailable: result.lamaAvailable,
      });
    } catch (error) {
      if (request.aborted || response.destroyed) return;
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof CleanPageError) {
        const status =
          error.code === 'INVALID_REQUEST'
            ? 400
            : error.code === 'IMAGE_TOO_LARGE'
              ? 413
              : 422;
        sendJson(response, status, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'CLEAN_PAGE_FAILED',
          message:
            error instanceof Error ? error.message : 'Page cleaning failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/align-words') {
    try {
      const value = asRecord(await readJsonBody(request, 60 * 1024 * 1024));
      const segments = Array.isArray(value.segments)
        ? (value.segments as unknown[])
        : null;
      const pcmBase64 = typeof value.pcm === 'string' ? value.pcm : null;
      const audioBase64 = typeof value.audio === 'string' ? value.audio : null;
      const sampleRateHz = Number(value.sampleRateHz ?? 16_000);
      const timebaseId =
        typeof value.timebaseId === 'string' && value.timebaseId
          ? value.timebaseId
          : 'audio:align-words';
      if (!segments || segments.length === 0) {
        throw new RequestError(
          400,
          'INVALID_ALIGN_REQUEST',
          'Provide segments[] with text and start/end seconds.',
        );
      }
      if (segments.length > 2000) {
        throw new RequestError(
          400,
          'INVALID_ALIGN_REQUEST',
          'At most 2000 transcript segments are accepted per alignment.',
        );
      }
      if (!pcmBase64 && !audioBase64) {
        throw new RequestError(
          400,
          'INVALID_ALIGN_REQUEST',
          'Provide pcm (base64 Float32LE) or audio (base64 compressed bytes).',
        );
      }
      if (
        !Number.isFinite(sampleRateHz) ||
        sampleRateHz < 8_000 ||
        sampleRateHz > 192_000
      ) {
        throw new RequestError(
          400,
          'INVALID_ALIGN_REQUEST',
          'sampleRateHz must be between 8000 and 192000.',
        );
      }

      let pcm: Float32Array;
      if (pcmBase64) {
        const buffer = Buffer.from(pcmBase64, 'base64');
        if (buffer.byteLength === 0) {
          throw new RequestError(
            400,
            'INVALID_ALIGN_REQUEST',
            'Decoded PCM is empty.',
          );
        }
        pcm = new Float32Array(
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        );
      } else {
        const decoded = await decodeAudioToPcm(
          new Uint8Array(Buffer.from(audioBase64!, 'base64')),
          { sampleRateHz },
        );
        if (decoded.pcm.length === 0) {
          throw new RequestError(
            400,
            'INVALID_ALIGN_REQUEST',
            'Decoded audio is empty.',
          );
        }
        pcm = decoded.pcm;
      }

      const provider = await loadWav2vec2ProviderOrThrow(state);
      const alignment = await alignWordsAcoustic({
        segments: segments.map((item, index) => {
          const segment = asRecord(item);
          const start = Number(segment.start);
          const end = Number(segment.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            throw new RequestError(
              400,
              'INVALID_ALIGN_REQUEST',
              `Segment ${index + 1} needs finite start < end in seconds.`,
            );
          }
          const text = typeof segment.text === 'string' ? segment.text : '';
          const words = Array.isArray(segment.words)
            ? (segment.words as unknown[])
                .map((w) => String(w))
                .filter((w) => w.trim().length > 0)
            : undefined;
          if (!text.trim() && (!words || words.length === 0)) {
            throw new RequestError(
              400,
              'INVALID_ALIGN_REQUEST',
              `Segment ${index + 1} needs non-empty text or words[].`,
            );
          }
          return {
            id:
              typeof segment.id === 'string' && segment.id
                ? segment.id
                : `segment-${index + 1}`,
            text,
            ...(words && words.length > 0 ? { words } : {}),
            interval: {
              start: {
                value: start,
                timebase: timebaseId as never,
                unit: 'seconds' as const,
              },
              end: {
                value: end,
                timebase: timebaseId as never,
                unit: 'seconds' as const,
              },
            },
            ...(typeof segment.speakerId === 'string'
              ? { speakerId: segment.speakerId }
              : {}),
          };
        }),
        timebase: {
          id: timebaseId as never,
          unit: 'seconds',
        },
        pcm,
        sampleRateHz,
        provider,
      });
      sendJson(response, 200, {
        words: alignment.words,
        confidence: alignment.confidence,
        algorithm: alignment.algorithm,
        provider: alignment.provider,
      });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof OnnxModelError) {
        sendJson(response, error.code === 'MODEL_MISSING' ? 503 : 422, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof AudioPcmError) {
        sendJson(response, error.code === 'FFMPEG_MISSING' ? 503 : 422, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof ForcedAlignAcousticError) {
        sendJson(response, 422, {
          error: { code: 'ALIGNMENT_INVALID', message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'ALIGNMENT_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Acoustic word alignment failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'GET' && request.url === '/api/models') {
    const models: Record<string, unknown> = {};
    try {
      yoloSessionPromise ??= loadYoloOnnxSession();
      const yolo = (await yoloSessionPromise) as { name: string };
      models.yolo = { available: true, name: yolo.name };
    } catch (error) {
      yoloSessionPromise = null;
      models.yolo = {
        available: false,
        code: error instanceof OnnxModelError ? error.code : 'MODEL_MISSING',
        message: error instanceof Error ? error.message : 'YOLO model unavailable.',
      };
    }
    try {
      wav2vecProviderPromise ??= loadWav2vec2CtcProvider();
      const wav2vec = (await wav2vecProviderPromise) as { name: string };
      models.wav2vec2 = { available: true, name: wav2vec.name };
    } catch (error) {
      wav2vecProviderPromise = null;
      models.wav2vec2 = {
        available: false,
        code: error instanceof OnnxModelError ? error.code : 'MODEL_MISSING',
        message:
          error instanceof Error ? error.message : 'wav2vec2 model unavailable.',
      };
    }
    sendJson(response, 200, { models });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/analyze-page') {
    const original = sourceImages.get('original');
    const cleaned = sourceImages.get('cleaned');
    if (!original && !cleaned) {
      sendJson(response, 409, {
        error: {
          code: 'IMAGE_REQUIRED',
          message: 'Import a comic page before scanning for bubbles.',
        },
      });
      return;
    }
    let requestedRole: SourceImageRole = cleaned ? 'cleaned' : 'original';
    let alignPair = Boolean(original && cleaned);
    if ((request.headers['content-type'] ?? '').includes('application/json')) {
      const options = asRecord(await readJsonBody(request, 16 * 1024));
      if (options.role === 'original' || options.role === 'cleaned')
        requestedRole = options.role;
      if (typeof options.alignPair === 'boolean') alignPair = options.alignPair;
    }
    if (alignPair && (!original || !cleaned)) {
      sendJson(response, 409, {
        error: {
          code: 'IMAGE_PAIR_REQUIRED',
          message: 'The requested aligned scan needs both comic pages.',
        },
      });
      return;
    }
    if (alignPair && !state.alignment) {
      sendJson(response, 409, {
        error: {
          code: 'ALIGNMENT_REQUIRED',
          message: 'Align the original and cleaned pages before scanning.',
        },
      });
      return;
    }
    try {
      const detectFrom = alignPair
        ? cleaned!
        : (sourceImages.get(requestedRole) ?? cleaned ?? original!);
      const coordinateSpace =
        alignPair && state.alignment
          ? state.alignment.targetSpace
          : createImageSpace(
              `image:${detectFrom.metadata.id}`,
              detectFrom.metadata.dimensions.width,
              detectFrom.metadata.dimensions.height,
            );
      const imageBytes =
        alignPair && state.alignment
          ? await renderAlignedCleanedImage(
              cleaned!.getBytes(),
              state.alignment!,
              Math.max(
                coordinateSpace.dimensions.width,
                coordinateSpace.dimensions.height,
              ),
            )
          : detectFrom.getBytes();
      // Hybrid: ML YOLO proposals boost recall when weights are present;
      // deterministic geometry always refines and scores contours.
      let detector: HybridBubbleDetector | typeof bubbleDetectionEngine =
        bubbleDetectionEngine;
      let proposalProviderName: string | null = null;
      try {
        yoloSessionPromise ??= loadYoloOnnxSession();
        const yoloSession = (await yoloSessionPromise) as ConstructorParameters<
          typeof YoloBubbleProposalProvider
        >[0]['session'] & { classLabels?: readonly string[] };
        proposalProviderName = `yolo:${yoloSession.name}`;
        detector = new HybridBubbleDetector({
          deterministic: bubbleDetectionEngine,
          provider: new YoloBubbleProposalProvider({
            session: yoloSession,
            ...(yoloSession.classLabels
              ? { classLabels: yoloSession.classLabels }
              : {}),
            confidenceThreshold: 0.25,
            bubbleClassesOnly: true,
            maximumProposals: 32,
          }),
        });
      } catch {
        // Fall back to pure deterministic detection when YOLO weights are absent.
        detector = bubbleDetectionEngine;
      }
      const detection = await detector.detect(imageBytes, coordinateSpace);
      const isHybrid =
        detection &&
        typeof detection === 'object' &&
        'bubbles' in detection &&
        'proposalCount' in detection;
      const detectionBubbles = isHybrid
        ? (detection as HybridBubbleDetectionResult).bubbles.map((entry) =>
            mapHybridBubble(entry),
          )
        : 'bubbles' in detection
          ? [...(detection as { bubbles: readonly Parameters<typeof mapDetectedBubble>[0][] }).bubbles].map(
              (bubble) => mapDetectedBubble(bubble),
            )
          : [];
      sendJson(response, 200, {
        coordinateSpace,
        bubbles: detectionBubbles,
        ocr: { coordinateSpace, blocks: [] },
        detection: isHybrid
          ? {
              mode: 'hybrid',
              provider: proposalProviderName,
              deterministicCount: (detection as HybridBubbleDetectionResult)
                .deterministicCount,
              proposalCount: (detection as HybridBubbleDetectionResult)
                .proposalCount,
              mergedCount: (detection as HybridBubbleDetectionResult).mergedCount,
              refinedCount: (detection as HybridBubbleDetectionResult).refinedCount,
              rejectedCount: (detection as HybridBubbleDetectionResult)
                .rejectedCount,
            }
          : {
              mode: 'deterministic',
              provider: null,
            },
      });
    } catch (error) {
      sendJson(response, 422, {
        error: {
          code: 'PAGE_ANALYSIS_FAILED',
          message:
            error instanceof Error ? error.message : 'Page analysis failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/ocr') {
    try {
      const value = await readJsonBody(request, 8 * 1024 * 1024);
      const scanRequest = parseOCRScanRequest(value);
      const sourceImage = sourceImages.get(scanRequest.role);
      if (!sourceImage) {
        sendJson(response, 409, {
          error: {
            code: 'OCR_IMAGE_REQUIRED',
            message: `Import the ${scanRequest.role} comic page before running OCR.`,
          },
        });
        return;
      }
      if (sourceImage.metadata.sha256 !== scanRequest.sourceHash) {
        sendJson(response, 409, {
          error: {
            code: 'OCR_SOURCE_CHANGED',
            message:
              'The active page changed before OCR began. Retry on the current page.',
          },
        });
        return;
      }
      if (
        scanRequest.coordinateSpaceId !== `workspace:${sourceImage.metadata.id}`
      ) {
        sendJson(response, 400, {
          error: {
            code: 'INVALID_OCR_COORDINATE_SPACE',
            message:
              'OCR geometry must use the active source page coordinate space.',
          },
        });
        return;
      }
      const result = await scanWithLocalOCR(
        sourceImage.getBytes(),
        sourceImage.metadata,
        {
          enhanced: scanRequest.enhanced,
          coordinateSpaceId: scanRequest.coordinateSpaceId,
          bubbles: scanRequest.bubbles,
        },
      );
      if (request.aborted || response.destroyed) return;
      const expectedSpace = createImageSpace(
        scanRequest.coordinateSpaceId,
        sourceImage.metadata.dimensions.width,
        sourceImage.metadata.dimensions.height,
      );
      const document = parseOCRDocument(
        result.document,
        expectedSpace,
        result.document.provenance,
      );
      sendJson(response, 200, { ...result, document });
    } catch (error) {
      if (request.aborted || response.destroyed) return;
      const status = error instanceof RequestError ? error.statusCode : 422;
      sendJson(response, status, {
        error: {
          code: error instanceof RequestError ? error.code : 'LOCAL_OCR_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Local OCR could not complete this page. Retry recognition.',
        },
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/automate-speech') {
    const original = sourceImages.get('original');
    const cleaned = sourceImages.get('cleaned');
    if (!original || !cleaned || !state.alignment) {
      sendJson(response, 409, {
        error: {
          code: 'PAGE_NOT_READY',
          message:
            'Import and align both comic pages before automating speech.',
        },
      });
      return;
    }
    try {
      const requestValue = await readJsonBody(request, 8 * 1024 * 1024);
      const requestRecord = asRecord(requestValue);
      const transcriptValue = requestRecord.transcript;
      const transcriptSegments = parseAutomationSegments(transcriptValue);
      const pageSpace = state.alignment.targetSpace;
      const suppliedOCR = requestRecord.ocr;
      const ocr = suppliedOCR
        ? parseOCRDocument(suppliedOCR, pageSpace, {
            source: '@paddleocr/paddleocr-js',
            version: '0.4.2 / PP-OCRv5 en',
            inputHashes: [original.metadata.sha256],
          })
        : null;
      const alignedCleaned = await renderAlignedCleanedImage(
        cleaned.getBytes(),
        state.alignment,
        Math.max(pageSpace.dimensions.width, pageSpace.dimensions.height),
      );
      const detection = await bubbleDetectionEngine.detect(
        alignedCleaned,
        pageSpace,
      );
      const originalTextRegions = (ocr?.blocks ?? []).flatMap((block) =>
        block.lines.map((line) => ocrLineRegion(line, pageSpace)),
      );
      const associations = ocr
        ? await bubbleAssociationEngine.associate({
            bubbles: detection.bubbles,
            originalTextRegions,
            ocrDocument: ocr,
            coordinateSpace: pageSpace,
          })
        : { references: [] };
      const ocrWarning = ocr
        ? null
        : 'Run local PaddleOCR first; bubble detection and manual matching are available without OCR.';
      const referenceByBubble = new Map(
        associations.references.map((reference) => [
          reference.bubbleId,
          reference,
        ]),
      );
      // Keep every detected bubble reviewable even when OCR or spatial association misses its lettering.
      const references: BubbleDialogueReference[] = detection.bubbles.map(
        (bubble) =>
          referenceByBubble.get(
            bubble.id as BubbleDialogueReference['bubbleId'],
          ) ?? {
            id: `reference:${bubble.id}`,
            bubbleId: bubble.id as BubbleDialogueReference['bubbleId'],
            textRegionIds: [],
            originalText: '',
            originalTextBounds: bubble.boundingBox,
            lineCount: 0,
            alignment: 'center',
            confidence: 0.1,
            status: 'pending-review',
            method: 'spatial',
            revision: 1,
          },
      );
      const bubbleById = new Map(
        detection.bubbles.map((bubble) => [bubble.id, bubble]),
      );
      const readingOrder = [...references]
        .sort((left, right) => {
          const a = bubbleById.get(left.bubbleId);
          const b = bubbleById.get(right.bubbleId);
          if (!a || !b) return 0;
          const verticalTolerance =
            Math.min(a.boundingBox.height, b.boundingBox.height) * 0.5;
          return Math.abs(a.boundingBox.y - b.boundingBox.y) > verticalTolerance
            ? a.boundingBox.y - b.boundingBox.y
            : a.boundingBox.x - b.boundingBox.x;
        })
        .map((reference) => reference.bubbleId);
      const mappingResult = new DialogueMappingEngine().map({
        bubbleReferences: references,
        readingOrder,
        transcriptSegments,
      });
      const font = automationFontMetrics();
      const matches = await Promise.all(
        mappingResult.mappings.map(async (mapping) => {
          const segment = transcriptSegments.find(
            (item) => item.id === mapping.transcriptSegmentId,
          )!;
          const candidateBubbleIds = mapping.alternatives.map(
            (candidate) => candidate.bubbleId,
          );
          const candidateLayouts = await Promise.all(
            candidateBubbleIds.map(async (bubbleId) => {
              const reference = references.find(
                (item) => item.bubbleId === bubbleId,
              );
              const bubble = detection.bubbles.find(
                (item) => item.id === bubbleId,
              );
              if (!reference || !bubble)
                return {
                  bubbleId,
                  layout: null,
                  fitError: 'Bubble geometry or text reference is unavailable.',
                };
              try {
                const safeRegion = await safeRegionEngine.compute({
                  bubble,
                  originalTextBounds: reference.originalTextBounds,
                  pageImage: original.getBytes(),
                  coordinateSpace: pageSpace,
                  internalPaddingPx: 6,
                });
                const layout = captionFittingEngine.fit({
                  caption: segment.text,
                  font,
                  fontSizeRange: { minPx: 12, maxPx: 36 },
                  safeRegion: safeRegion.region,
                  paddingPx: 1,
                  alignment:
                    reference.alignment === 'unknown'
                      ? 'center'
                      : reference.alignment,
                  lineSpacingPx: 2,
                });
                return { bubbleId, layout, fitError: null };
              } catch (error) {
                return {
                  bubbleId,
                  layout: null,
                  fitError:
                    error instanceof Error
                      ? error.message
                      : 'Caption did not fit the safe region.',
                };
              }
            }),
          );
          const selected = candidateLayouts.find(
            (candidate) => candidate.bubbleId === mapping.bubbleId,
          );
          return {
            mapping,
            segmentId: segment.id,
            layout: selected?.layout ?? null,
            fitError:
              selected?.fitError ??
              (mapping.bubbleId
                ? 'No caption layout was produced.'
                : 'Choose a reviewed bubble candidate to fit this caption.'),
            candidateLayouts,
          };
        }),
      );
      sendJson(response, 200, {
        coordinateSpace: pageSpace,
        bubbles: detection.bubbles.map(
          ({ id, kind, polygon, confidence, tail }) => ({
            id,
            kind,
            polygon,
            confidence,
            tail: tail?.points ?? null,
          }),
        ),
        ocr: {
          coordinateSpace: pageSpace,
          blocks:
            ocr?.blocks.map((block) => ({
              lines: block.lines.map(
                ({ id, text, confidence, boundingBox }) => ({
                  id,
                  text,
                  confidence,
                  boundingBox,
                }),
              ),
            })) ?? [],
        },
        ocrWarning,
        matches,
        unmappedTranscriptSegmentIds:
          mappingResult.unmappedTranscriptSegmentIds,
      });
    } catch (error) {
      const status = error instanceof RequestError ? error.statusCode : 422;
      sendJson(response, status, {
        error: {
          code:
            error instanceof RequestError
              ? error.code
              : 'SPEECH_AUTOMATION_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Speech automation failed.',
        },
      });
    }
    return;
  }

  if (request.method === 'GET' && request.url === '/api/images') {
    sendJson(response, 200, currentPair(sourceImages));
    return;
  }

  if (request.method === 'GET' && request.url === '/api/alignment') {
    if (!state.alignment) {
      sendJson(response, 404, {
        error: {
          code: 'ALIGNMENT_NOT_FOUND',
          message: 'Align the imported images first.',
        },
      });
      return;
    }
    sendJson(response, 200, state.alignment);
    return;
  }

  const visualizationRoute = request.url?.match(
    /^\/api\/alignment\/visualization\/(overlay|difference)$/,
  );
  if (request.method === 'GET' && visualizationRoute) {
    if (!state.alignment) {
      sendJson(response, 404, {
        error: {
          code: 'ALIGNMENT_NOT_FOUND',
          message: 'Align the imported images first.',
        },
      });
      return;
    }
    const original = sourceImages.get('original');
    const cleaned = sourceImages.get('cleaned');
    if (!original || !cleaned) {
      sendJson(response, 409, {
        error: {
          code: 'IMAGE_PAIR_REQUIRED',
          message: 'Import both images before alignment.',
        },
      });
      return;
    }
    if (!state.visualizations) {
      state.visualizations = await renderAlignmentVisualizations(
        original.getBytes(),
        cleaned.getBytes(),
        state.alignment,
      );
    }
    const visualizations = state.visualizations;
    const bytes =
      visualizationRoute[1] === 'overlay'
        ? visualizations.overlayPng
        : visualizations.differencePng;
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': bytes.byteLength,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(bytes);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/text-differences') {
    const original = sourceImages.get('original');
    const cleaned = sourceImages.get('cleaned');
    if (!original || !cleaned) {
      sendJson(response, 409, {
        error: {
          code: 'IMAGE_PAIR_REQUIRED',
          message: 'Import both images before detecting removed text.',
        },
      });
      return;
    }
    if (!state.alignment) {
      sendJson(response, 409, {
        error: {
          code: 'ALIGNMENT_REQUIRED',
          message: 'Align the images before detecting removed text.',
        },
      });
      return;
    }
    try {
      const alignedCleaned = await renderAlignedCleanedImage(
        cleaned.getBytes(),
        state.alignment,
      );
      state.textDifferences = await textDifferenceEngine.detect(
        original.getBytes(),
        alignedCleaned,
        state.alignment.targetSpace,
      );
      sendJson(response, 200, {
        regions: state.textDifferences.regions,
        maskSpace: state.textDifferences.maskSpace,
      });
    } catch (error) {
      sendJson(response, 422, {
        error: {
          code: 'TEXT_DIFFERENCE_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Removed text could not be detected.',
        },
      });
    }
    return;
  }

  const textVisualizationRoute = request.url?.match(
    /^\/api\/text-differences\/(debug|difference)$/,
  );
  if (request.method === 'GET' && textVisualizationRoute) {
    if (!state.textDifferences) {
      sendJson(response, 404, {
        error: {
          code: 'TEXT_DIFFERENCES_NOT_FOUND',
          message: 'Run text difference detection first.',
        },
      });
      return;
    }
    const bytes =
      textVisualizationRoute[1] === 'debug'
        ? state.textDifferences.debugPng
        : state.textDifferences.differencePng;
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': bytes.byteLength,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(bytes);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/alignment') {
    const original = sourceImages.get('original');
    const cleaned = sourceImages.get('cleaned');
    if (!original || !cleaned) {
      sendJson(response, 409, {
        error: {
          code: 'IMAGE_PAIR_REQUIRED',
          message: 'Import both original and cleaned images before alignment.',
        },
      });
      return;
    }
    try {
      state.alignment = await alignmentEngine.align(original, cleaned);
      state.visualizations = null;
      state.textDifferences = null;
      sendJson(response, 200, state.alignment);
    } catch (error) {
      sendJson(response, 422, {
        error: {
          code:
            error instanceof AlignmentError
              ? 'ALIGNMENT_FAILED'
              : 'ALIGNMENT_ERROR',
          message:
            error instanceof Error
              ? error.message
              : 'The images could not be aligned.',
        },
      });
    }
    return;
  }

  if (request.method === 'PUT' && request.url === '/api/alignment/manual') {
    if (!state.alignment) {
      sendJson(response, 404, {
        error: {
          code: 'ALIGNMENT_NOT_FOUND',
          message: 'Estimate alignment before applying a manual correction.',
        },
      });
      return;
    }
    try {
      const value = await readJsonBody(request);
      if (!isManualAlignment(value))
        throw new RequestError(
          400,
          'INVALID_ALIGNMENT',
          'Provide numeric scale, rotation, translationX, and translationY values.',
        );
      state.alignment = applyManualAlignment(state.alignment, value);
      state.visualizations = null;
      state.textDifferences = null;
      sendJson(response, 200, state.alignment);
    } catch (error) {
      const status = error instanceof RequestError ? error.statusCode : 422;
      sendJson(response, status, {
        error: {
          code:
            error instanceof RequestError ? error.code : 'INVALID_ALIGNMENT',
          message:
            error instanceof Error
              ? error.message
              : 'The manual alignment is invalid.',
        },
      });
    }
    return;
  }

  const contentRoute = request.url?.match(
    /^\/api\/images\/(original|cleaned)\/content$/,
  );
  if (request.method === 'GET' && contentRoute) {
    const sourceImage = sourceImages.get(contentRoute[1] as SourceImageRole);
    if (!sourceImage) {
      sendJson(response, 404, {
        error: {
          code: 'IMAGE_NOT_FOUND',
          message: 'No image has been imported for this role.',
        },
      });
      return;
    }
    const bytes = sourceImage.getBytes();
    response.writeHead(200, {
      'content-type': sourceImage.metadata.mediaType,
      'content-length': bytes.byteLength,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(bytes);
    return;
  }

  const imageRoute = request.url?.match(/^\/api\/images\/(original|cleaned)$/);
  if (request.method === 'POST' && imageRoute) {
    try {
      const role = imageRoute[1] as SourceImageRole;
      const upload = await readMultipartImage(request);
      const sourceImage = await ImmutableSourceImage.import({
        role,
        filename: upload.filename,
        bytes: upload.bytes,
      });
      sourceImages.set(role, sourceImage);
      state.alignment = null;
      state.visualizations = null;
      state.textDifferences = null;
      sendJson(response, 201, {
        image: sourceImage.metadata,
        pair: currentPair(sourceImages),
      });
    } catch (error) {
      if (error instanceof SourceImageImportError) {
        sendJson(response, importErrorStatus(error), {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'IMPORT_FAILED',
          message: 'The image could not be imported.',
        },
      });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

export interface CreateApiServerOptions {
  /**
   * Inject a CTC frame-posteriors provider (tests use
   * `SyntheticCtcPosteriorsProvider`) so unit tests need no ONNX weights.
   */
  readonly ctcProvider?: CtcFramePosteriorsProvider;
}

export function createApiServer(options: CreateApiServerOptions = {}): Server {
  const state: ApiState = {
    sourceImages: new Map(),
    alignment: null,
    visualizations: null,
    textDifferences: null,
    ...(options.ctcProvider ? { ctcProviderOverride: options.ctcProvider } : {}),
  };
  return createServer((request, response) => {
    void handleRequest(request, response, state);
  });
}

function spaceIdFrom(value: Record<string, unknown>): string | undefined {
  return typeof value.spaceId === 'string' && value.spaceId
    ? value.spaceId
    : undefined;
}

async function decodeCleanRaster(
  encoded: Uint8Array,
  width: number,
  height: number,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const sharp = (await import('sharp')).default;
  // Raw RGBA when width/height are supplied and length matches.
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    encoded.byteLength === width * height * 4
  ) {
    return {
      width,
      height,
      data: new Uint8ClampedArray(
        encoded.buffer,
        encoded.byteOffset,
        encoded.byteLength,
      ),
    };
  }
  try {
    const { data, info } = await sharp(encoded)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    };
  } catch {
    throw new RequestError(
      400,
      'INVALID_CLEAN_REQUEST',
      'pageImage could not be decoded as PNG/JPEG/RGBA.',
    );
  }
}

function parseCleanTextRegions(
  value: unknown,
  raster: { width: number; height: number },
  spaceId: string | undefined,
): LetteringSourceRegion[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RequestError(
      400,
      'INVALID_CLEAN_REQUEST',
      'textRegions must be an array.',
    );
  }
  const space = createImageSpace(
    spaceId ?? `image:clean-${raster.width}x${raster.height}`,
    raster.width,
    raster.height,
  );
  return value.map((item, index) => {
    const region = asRecord(item);
    const id =
      typeof region.id === 'string' && region.id
        ? region.id
        : `region-${index + 1}`;
    const source: {
      id: string;
      boundingBox?: LetteringSourceRegion['boundingBox'];
      polygon?: LetteringSourceRegion['polygon'];
      mask?: Uint8Array;
      associatedBubbleId?: string | null;
      detectionConfidence?: number;
      reviewStatus?: LetteringSourceRegion['reviewStatus'];
      approved?: boolean;
    } = { id };
    if (Array.isArray(region.boundingBox)) {
      const [x, y, w, h] = region.boundingBox as number[];
      source.boundingBox = {
        x: Number(x),
        y: Number(y),
        width: Number(w),
        height: Number(h),
        coordinateSpace: space,
      };
    } else if (region.boundingBox && typeof region.boundingBox === 'object') {
      const box = asRecord(region.boundingBox);
      source.boundingBox = {
        x: Number(box.x),
        y: Number(box.y),
        width: Number(box.width),
        height: Number(box.height),
        coordinateSpace: space,
      };
    }
    if (Array.isArray(region.polygon) && region.polygon.length >= 3) {
      source.polygon = {
        coordinateSpace: space,
        points: (region.polygon as unknown[]).map((point) => {
          const p = asRecord(point);
          return {
            x: Number(p.x),
            y: Number(p.y),
            coordinateSpace: space,
          };
        }),
      };
    }
    if (typeof region.mask === 'string') {
      source.mask = new Uint8Array(Buffer.from(region.mask, 'base64'));
    }
    if (typeof region.associatedBubbleId === 'string') {
      source.associatedBubbleId = region.associatedBubbleId;
    } else if (region.associatedBubbleId === null) {
      source.associatedBubbleId = null;
    }
    if (typeof region.detectionConfidence === 'number') {
      source.detectionConfidence = region.detectionConfidence;
    }
    if (
      region.reviewStatus === 'pending' ||
      region.reviewStatus === 'accepted' ||
      region.reviewStatus === 'rejected' ||
      region.reviewStatus === 'edited'
    ) {
      source.reviewStatus = region.reviewStatus;
    }
    if (region.approved === true) source.approved = true;
    return source as LetteringSourceRegion;
  });
}

function parseCleanBubbles(value: unknown): {
  id: string;
  contour: { points: readonly { x: number; y: number }[] };
  boundingBox?: { x: number; y: number; width: number; height: number };
  interiorHint?:
    | 'white-balloon'
    | 'coloured-balloon'
    | 'textured-balloon'
    | 'artwork'
    | 'unknown';
}[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RequestError(
      400,
      'INVALID_CLEAN_REQUEST',
      'bubbles must be an array.',
    );
  }
  return value.map((item, index) => {
    const bubble = asRecord(item);
    const contour = asRecord(bubble.contour);
    const points = Array.isArray(contour.points)
      ? contour.points
      : Array.isArray(bubble.polygon)
        ? bubble.polygon
        : [];
    const hint = bubble.interiorHint;
    const interiorHint =
      hint === 'white-balloon' ||
      hint === 'coloured-balloon' ||
      hint === 'textured-balloon' ||
      hint === 'artwork' ||
      hint === 'unknown'
        ? hint
        : undefined;
    const box = asRecord(bubble.boundingBox);
    const boundingBox =
      typeof box.x === 'number' &&
      typeof box.y === 'number' &&
      typeof box.width === 'number' &&
      typeof box.height === 'number'
        ? {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          }
        : undefined;
    return {
      id:
        typeof bubble.id === 'string' && bubble.id
          ? bubble.id
          : `bubble-${index + 1}`,
      contour: {
        points: (points as unknown[]).map((point) => {
          const p = asRecord(point);
          return { x: Number(p.x), y: Number(p.y) };
        }),
      },
      ...(boundingBox ? { boundingBox } : {}),
      ...(interiorHint ? { interiorHint } : {}),
    };
  });
}

function parseManualEdits(
  value: unknown,
  width: number,
  height: number,
): {
  regionId?: string;
  addPixels?: Uint8Array;
  excludePixels?: Uint8Array;
}[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RequestError(
      400,
      'INVALID_CLEAN_REQUEST',
      'manualEdits must be an array.',
    );
  }
  const pixelCount = width * height;
  return value.map((item) => {
    const edit = asRecord(item);
    const out: {
      regionId?: string;
      addPixels?: Uint8Array;
      excludePixels?: Uint8Array;
    } = {};
    if (typeof edit.regionId === 'string') out.regionId = edit.regionId;
    if (typeof edit.addPixels === 'string') {
      const pixels = new Uint8Array(Buffer.from(edit.addPixels, 'base64'));
      if (pixels.length !== pixelCount) {
        throw new RequestError(
          400,
          'INVALID_CLEAN_REQUEST',
          'manual addPixels must match page dimensions.',
        );
      }
      out.addPixels = pixels;
    }
    if (typeof edit.excludePixels === 'string') {
      const pixels = new Uint8Array(Buffer.from(edit.excludePixels, 'base64'));
      if (pixels.length !== pixelCount) {
        throw new RequestError(
          400,
          'INVALID_CLEAN_REQUEST',
          'manual excludePixels must match page dimensions.',
        );
      }
      out.excludePixels = pixels;
    }
    return out;
  });
}

function parseOCRScanRequest(value: unknown): {
  readonly role: SourceImageRole;
  readonly sourceHash: string;
  readonly coordinateSpaceId: string;
  readonly enhanced: boolean;
  readonly bubbles: readonly OCRBubbleInput[];
} {
  const candidate = asRecord(value);
  if (
    (candidate.role !== 'original' && candidate.role !== 'cleaned') ||
    typeof candidate.sourceHash !== 'string' ||
    !/^[a-f\d]{64}$/i.test(candidate.sourceHash) ||
    typeof candidate.coordinateSpaceId !== 'string' ||
    candidate.coordinateSpaceId.length < 1 ||
    candidate.coordinateSpaceId.length > 180 ||
    typeof candidate.enhanced !== 'boolean' ||
    (candidate.bubbles !== undefined && !Array.isArray(candidate.bubbles))
  ) {
    throw new RequestError(
      400,
      'INVALID_OCR_REQUEST',
      'Provide a source page, source hash, preprocessing mode, and optional bubble crop regions.',
    );
  }
  const values = (candidate.bubbles ?? []) as unknown[];
  if (values.length > 128) {
    throw new RequestError(
      413,
      'TOO_MANY_OCR_CROPS',
      'OCR can process at most 128 bubble regions at a time.',
    );
  }
  const bubbles = values.map((value, index) => {
    const region = asRecord(value);
    const points = region.polygon;
    if (
      typeof region.id !== 'string' ||
      region.id.length < 1 ||
      region.id.length > 128 ||
      !Array.isArray(points) ||
      points.length < 3 ||
      points.length > 256 ||
      points.some((value) => {
        const point = asRecord(value);
        return (
          typeof point.x !== 'number' ||
          !Number.isFinite(point.x) ||
          typeof point.y !== 'number' ||
          !Number.isFinite(point.y)
        );
      }) ||
      (region.cropPadding !== undefined &&
        (typeof region.cropPadding !== 'number' ||
          !Number.isFinite(region.cropPadding) ||
          region.cropPadding < 0.02 ||
          region.cropPadding > 0.24))
    ) {
      throw new RequestError(
        400,
        'INVALID_OCR_CROP',
        `Bubble crop ${index + 1} has invalid image geometry.`,
      );
    }
    const allowedReviewStatuses = [
      'pending-review',
      'accepted',
      'edited',
      'rejected',
    ];
    if (
      region.reviewStatus !== undefined &&
      (typeof region.reviewStatus !== 'string' ||
        !allowedReviewStatuses.includes(region.reviewStatus))
    ) {
      throw new RequestError(
        400,
        'INVALID_OCR_CROP',
        `Bubble crop ${index + 1} has an invalid review status.`,
      );
    }
    return {
      id: region.id,
      polygon: points as OCRBubbleInput['polygon'],
      ...(region.reviewStatus ? { reviewStatus: region.reviewStatus } : {}),
      ...(region.cropPadding !== undefined
        ? { cropPadding: region.cropPadding as number }
        : {}),
    };
  });
  return {
    role: candidate.role,
    sourceHash: candidate.sourceHash,
    coordinateSpaceId: candidate.coordinateSpaceId,
    enhanced: candidate.enhanced,
    bubbles,
  };
}

function isManualAlignment(value: unknown): value is {
  readonly scale: number;
  readonly rotation: number;
  readonly translationX: number;
  readonly translationY: number;
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['scale', 'rotation', 'translationX', 'translationY'].every(
    (key) =>
      typeof candidate[key] === 'number' && Number.isFinite(candidate[key]),
  );
}

function isAssistInput(value: unknown): value is AssistInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const tasks = [
    'ocr-correction',
    'bubble-classification',
    'dialogue-mapping',
    'speaker-context',
    'transcription-correction',
  ];
  return (
    tasks.includes(String(candidate.task)) &&
    typeof candidate.targetId === 'string' &&
    candidate.targetId.length > 0 &&
    candidate.context !== null &&
    typeof candidate.context === 'object' &&
    !Array.isArray(candidate.context)
  );
}

export function startApiServer(port = Number(process.env.API_PORT ?? 3039)) {
  const server = createApiServer();
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(
        `API port ${port} is already in use. Set API_PORT to an available port and restart both servers.\n`,
      );
      return;
    }
    process.stderr.write(`API server failed: ${error.message}\n`);
  });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort =
      typeof address === 'object' && address ? address.port : port;
    process.stdout.write(
      `${serviceName} listening on http://localhost:${boundPort}\n`,
    );
  });
  return server;
}
