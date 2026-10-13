import type { CaptionLayout } from '@comic-captioner/core';
import { TimelineEngine } from '../../../packages/caption-engine/src/timeline.js';
import type { DialogueEvent } from '@comic-captioner/core';
import type { AudioTimebaseId } from '@comic-captioner/shared';
import {
  captionMotionAtTime,
  renderCaptionLayerSvg,
} from '../../../packages/rendering/src/svg.js';
import { validateFrameExport } from '../../../packages/rendering/src/validation.js';
import type {
  ExportBubble,
  ExportCaption,
} from '../../../packages/rendering/src/validation.js';
import { resolveMp4Dimensions } from '../../../packages/rendering/src/frame-renderer.js';

export { resolveMp4Dimensions };
export type {
  Mp4ExportOptions,
  Mp4Resolution,
} from '../../../packages/rendering/src/frame-renderer.js';
import type { Mp4ExportOptions } from '../../../packages/rendering/src/frame-renderer.js';

export interface Mp4ExportProgress {
  readonly percent: number;
  readonly currentTime: number;
  readonly duration: number;
}

type CapturableAudioElement = HTMLAudioElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

/** Record the preview's shared SVG caption primitive against the source audio clock. */
export async function exportMp4(
  cleanedComic: Blob,
  audioAsset: Blob,
  captions: readonly ExportCaption[],
  bubbles: readonly ExportBubble[],
  options: Mp4ExportOptions,
  signal: AbortSignal,
  onProgress: (progress: Mp4ExportProgress) => void,
): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined')
    throw new Error('MP4 recording is not available in this browser.');
  const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType)
    throw new Error(
      'This browser cannot encode MP4 video with audio. Use a browser with MP4 recording support.',
    );
  const validation = validateFrameExport(captions, bubbles);
  if (!validation.valid)
    throw new Error(
      `Export validation failed: ${validation.issues.map((issue) => `${issue.captionId}: ${issue.code}`).join(', ')}`,
    );
  const timebase = 'audio:mp4-export' as AudioTimebaseId;
  const timeline = new TimelineEngine(
    captions.map((caption): DialogueEvent => ({
      id: caption.id,
      bubbleId: caption.bubbleId,
      caption: caption.caption,
      start: { value: caption.start!, timebase, unit: 'seconds' },
      end: { value: caption.end!, timebase, unit: 'seconds' },
      layout: caption.layout as CaptionLayout,
      confidence: caption.confidence!,
    })),
  );
  const { width, height } = resolveMp4Dimensions(options);
  const comic = await createImageBitmap(cleanedComic);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    comic.close();
    throw new Error('Could not create the MP4 frame canvas.');
  }
  const scale = Math.min(width / comic.width, height / comic.height);
  const pageWidth = comic.width * scale;
  const pageHeight = comic.height * scale;
  const offsetX = (width - pageWidth) / 2;
  const offsetY = (height - pageHeight) / 2;
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  const audioUrl = URL.createObjectURL(audioAsset);
  audio.src = audioUrl;
  audio.load();
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Export cancelled.', 'AbortError'));
        return;
      }
      const onMetadata = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Audio asset could not be decoded for export.'));
      };
      const onCancel = () => {
        cleanup();
        reject(new DOMException('Export cancelled.', 'AbortError'));
      };
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', onMetadata);
        audio.removeEventListener('error', onError);
        signal.removeEventListener('abort', onCancel);
      };
      audio.addEventListener('loadedmetadata', onMetadata, { once: true });
      audio.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onCancel, { once: true });
    });
  } catch (cause) {
    URL.revokeObjectURL(audioUrl);
    audio.removeAttribute('src');
    audio.load();
    comic.close();
    throw cause;
  }
  if (captions.some((caption) => caption.end! > audio.duration)) {
    URL.revokeObjectURL(audioUrl);
    audio.removeAttribute('src');
    audio.load();
    comic.close();
    throw new Error(
      'Export validation failed: one or more dialogue timings extend past the audio duration.',
    );
  }
  const videoStream = canvas.captureStream(30);
  const capturableAudio = audio as CapturableAudioElement;
  const audioCapture =
    capturableAudio.captureStream ?? capturableAudio.mozCaptureStream;
  const audioStream = audioCapture?.call(audio) ?? null;
  if (!audioStream) {
    URL.revokeObjectURL(audioUrl);
    videoStream.getTracks().forEach((track) => track.stop());
    comic.close();
    throw new Error('This browser cannot capture audio for MP4 export.');
  }
  audioStream.getAudioTracks().forEach((track) => videoStream.addTrack(track));
  const recorder = new MediaRecorder(videoStream, { mimeType });
  const chunks: BlobPart[] = [];
  let animation = 0;
  let cancelled = false;
  let rendering = false;
  let duration = 0;
  let lastProgressUpdate = 0;

  const stopRecorder = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const abort = () => {
    cancelled = true;
    cancelAnimationFrame(animation);
    audio.pause();
    stopRecorder();
  };
  const cleanup = () => {
    cancelAnimationFrame(animation);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(audioUrl);
    videoStream.getTracks().forEach((track) => track.stop());
    audioStream.getTracks().forEach((track) => track.stop());
    comic.close();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => reject(new Error('MP4 encoding failed.'));
      recorder.onstop = () => resolve();
      signal.addEventListener('abort', abort, { once: true });
      const pump = async () => {
        if (rendering) return;
        rendering = true;
        try {
          const time = audio.currentTime;
          context.fillStyle = '#000';
          context.fillRect(0, 0, width, height);
          context.drawImage(comic, offsetX, offsetY, pageWidth, pageHeight);
          const activeEvent = timeline.getActiveDialogue({
            value: time,
            timebase,
            unit: 'seconds',
          });
          const layouts = activeEvent ? [activeEvent.layout] : [];
          const svgBlob = new Blob(
            [
              renderCaptionLayerSvg(
                comic.width,
                comic.height,
                layouts,
                activeEvent
                  ? captionMotionAtTime(
                      activeEvent.start.value,
                      activeEvent.end.value,
                      time,
                    )
                  : undefined,
              ),
            ],
            { type: 'image/svg+xml' },
          );
          const overlay = await createImageBitmap(svgBlob);
          if (cancelled || signal.aborted) {
            overlay.close();
            stopRecorder();
            return;
          }
          context.drawImage(overlay, offsetX, offsetY, pageWidth, pageHeight);
          overlay.close();
          duration = Number.isFinite(audio.duration)
            ? audio.duration
            : duration;
          const now = performance.now();
          if (now - lastProgressUpdate >= 250) {
            lastProgressUpdate = now;
            onProgress({
              percent: duration ? Math.min(100, (time / duration) * 100) : 0,
              currentTime: time,
              duration,
            });
          }
        } catch (cause) {
          cancelAnimationFrame(animation);
          stopRecorder();
          reject(
            cause instanceof Error
              ? cause
              : new Error('Caption rendering failed.'),
          );
          return;
        } finally {
          rendering = false;
        }
        if (cancelled || signal.aborted || audio.ended) stopRecorder();
        else
          animation = requestAnimationFrame(() => {
            void pump();
          });
      };
      recorder.start(1000);
      if (signal.aborted) abort();
      void audio
        .play()
        .then(() => {
          duration = audio.duration || duration;
          animation = requestAnimationFrame(() => {
            void pump();
          });
        })
        .catch(() => {
          stopRecorder();
          reject(new Error('Audio playback could not start for export.'));
        });
    });
  } finally {
    signal.removeEventListener('abort', abort);
    cleanup();
  }
  if (cancelled || signal.aborted)
    throw new DOMException('Export cancelled.', 'AbortError');
  if (!chunks.length) throw new Error('MP4 export produced no encoded data.');
  onProgress({ percent: 100, currentTime: duration, duration });
  return new Blob(chunks, { type: 'video/mp4' });
}

const SERVER_EXPORT_FPS = 30;

const audioExtensions: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

function audioFormatFromBlob(audioAsset: Blob): string {
  const mime = audioAsset.type.toLowerCase().split(';')[0]!.trim();
  return audioExtensions[mime] ?? 'bin';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  return btoa(binary);
}

function readAudioDuration(audioAsset: Blob, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(audioAsset);
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', onMetadata);
      audio.removeEventListener('error', onError);
      signal.removeEventListener('abort', onCancel);
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      audio.load();
    };
    const onMetadata = () => {
      const duration = audio.duration;
      cleanup();
      resolve(duration);
    };
    const onError = () => {
      cleanup();
      reject(new Error('Audio asset could not be decoded for export.'));
    };
    const onCancel = () => {
      cleanup();
      reject(new DOMException('Export cancelled.', 'AbortError'));
    };
    audio.preload = 'auto';
    audio.addEventListener('loadedmetadata', onMetadata, { once: true });
    audio.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onCancel, { once: true });
    audio.src = url;
    audio.load();
  });
}

/**
 * Server-side export: the API renders deterministic frames and encodes them
 * with FFmpeg. When the API is unreachable or cannot encode (for example
 * FFMPEG_MISSING), falls back to the real-time captureStream path.
 */
export async function exportMp4ViaServer(
  cleanedComic: Blob,
  audioAsset: Blob,
  captions: readonly ExportCaption[],
  bubbles: readonly ExportBubble[],
  options: Mp4ExportOptions,
  signal: AbortSignal,
  onProgress: (progress: Mp4ExportProgress) => void,
): Promise<Blob> {
  const validation = validateFrameExport(captions, bubbles);
  if (!validation.valid)
    throw new Error(
      `Export validation failed: ${validation.issues.map((issue) => `${issue.captionId}: ${issue.code}`).join(', ')}`,
    );
  let durationSeconds: number;
  try {
    durationSeconds = await readAudioDuration(audioAsset, signal);
  } catch (cause) {
    if (
      signal.aborted ||
      (cause instanceof DOMException && cause.name === 'AbortError')
    )
      throw cause;
    return exportMp4(
      cleanedComic,
      audioAsset,
      captions,
      bubbles,
      options,
      signal,
      onProgress,
    );
  }
  if (captions.some((caption) => caption.end! > durationSeconds))
    throw new Error(
      'Export validation failed: one or more dialogue timings extend past the audio duration.',
    );
  try {
    onProgress({ percent: 5, currentTime: 0, duration: durationSeconds });
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageImage: toBase64(new Uint8Array(await cleanedComic.arrayBuffer())),
        audio: toBase64(new Uint8Array(await audioAsset.arrayBuffer())),
        audioFormat: audioFormatFromBlob(audioAsset),
        fps: SERVER_EXPORT_FPS,
        durationSeconds,
        resolution: options,
        captions,
        bubbles,
      }),
      signal,
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const message =
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        payload.error &&
        typeof payload.error === 'object' &&
        'message' in payload.error &&
        typeof payload.error.message === 'string'
          ? payload.error.message
          : `Server-side MP4 export failed (${response.status}).`;
      throw new Error(message);
    }
    const mp4 = await response.arrayBuffer();
    if (!mp4.byteLength)
      throw new Error('Server-side MP4 export produced no encoded data.');
    onProgress({
      percent: 100,
      currentTime: durationSeconds,
      duration: durationSeconds,
    });
    return new Blob([mp4], { type: 'video/mp4' });
  } catch (cause) {
    if (
      signal.aborted ||
      (cause instanceof DOMException && cause.name === 'AbortError')
    )
      throw cause;
    return exportMp4(
      cleanedComic,
      audioAsset,
      captions,
      bubbles,
      options,
      signal,
      onProgress,
    );
  }
}
