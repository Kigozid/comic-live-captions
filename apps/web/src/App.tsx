import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import type {
  AlignmentResult,
  ImageSpace,
  OCRDocument,
  SourceImageMetadata,
  SourceImageRole,
  TextRegion,
} from '@comic-captioner/shared';
import {
  createDisplaySpace,
  createImageSpace,
  imageToDisplay,
} from '@comic-captioner/shared';
import { AudioWorkspace } from './AudioWorkspace.js';
import type { AudioPlaybackControls } from './AudioWorkspace.js';
import { LayeredComicRenderer } from './LayeredComicRenderer.js';
import { EditingWorkspace } from './EditingWorkspace.js';
import {
  ProjectService,
  IndexedDbProjectRepository,
  hashBlob,
} from './project-persistence.js';
import type { ProjectSnapshot } from './project-persistence.js';
import type { EditorDocument } from './editor-model.js';
import type { ClockSnapshot, Transcript } from '@comic-captioner/audio-engine';
import type { CaptionLayout } from '@comic-captioner/core';
import type { DialogueMapping } from '@comic-captioner/core';
import { proposeTranscriptBubbleMappings } from './dialogue-review.js';
import { recognizeComicBubbles, recognizeComicPage } from './paddle-ocr.js';
import type { PaddleOCRStatus } from './paddle-ocr.js';
import type {
  ExportBubble,
  ExportCaption,
} from '../../../packages/rendering/src/validation.js';
import { exportComicFrame } from './browser-export.js';
import { exportMp4ViaServer } from './mp4-export.js';
import type { Mp4ExportProgress, Mp4Resolution } from './mp4-export.js';
import {
  autoCleanPage,
  detectBubblesHybrid,
  detectPanelsAndOrder,
  needsAutoClean,
  rasterFromImageSource,
  rasterToPngBlob,
  triageOcrDocument,
} from './engine-adapters.js';

interface ImagePair {
  readonly original: SourceImageMetadata | null;
  readonly cleaned: SourceImageMetadata | null;
  readonly dimensionsMatch: boolean | null;
}

interface ViewportState {
  readonly width: number;
  readonly height: number;
}

interface PanState {
  readonly x: number;
  readonly y: number;
}

interface ImageLayer {
  readonly role: SourceImageRole;
  readonly metadata: SourceImageMetadata;
  readonly src: string;
  readonly opacity?: number;
}

interface ImageCanvasProps {
  readonly title: string;
  readonly layers: readonly ImageLayer[];
  readonly comparison?: boolean;
  readonly toolbar?: boolean;
}

interface AlignmentImages {
  readonly overlay: string;
  readonly difference: string;
}

interface SpeechAutomationMatch {
  readonly mapping: DialogueMapping;
  readonly segmentId: string;
  readonly layout: CaptionLayout | null;
  readonly fitError: string | null;
  readonly candidateLayouts: readonly {
    readonly bubbleId: string;
    readonly layout: CaptionLayout | null;
    readonly fitError: string | null;
  }[];
  readonly ocrWarning?: string | null;
}

const emptyPair: ImagePair = {
  original: null,
  cleaned: null,
  dimensionsMatch: null,
};

export function OriginalViewer({
  image,
  captionLayouts = [],
}: {
  readonly image: ImageLayer | null;
  readonly captionLayouts?: readonly import('@comic-captioner/core').CaptionLayout[];
}) {
  return image && captionLayouts.length > 0 ? (
    <LayeredComicRenderer
      src={image.src}
      width={image.metadata.dimensions.width}
      height={image.metadata.dimensions.height}
      layouts={captionLayouts}
    />
  ) : (
    <ImageCanvas title="Original comic" layers={image ? [image] : []} />
  );
}

export function CleanedViewer({
  image,
}: {
  readonly image: ImageLayer | null;
}) {
  return <ImageCanvas title="Cleaned comic" layers={image ? [image] : []} />;
}

export function ComparisonViewer({
  original,
  cleaned,
  opacity,
  onOpacityChange,
  dimensionsMatch,
}: {
  readonly original: ImageLayer | null;
  readonly cleaned: ImageLayer | null;
  readonly opacity: number;
  readonly onOpacityChange: (opacity: number) => void;
  readonly dimensionsMatch: boolean | null;
}) {
  const layers = [
    ...(original ? [{ ...original, opacity: 1 }] : []),
    ...(cleaned ? [{ ...cleaned, opacity }] : []),
  ];

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">
            Comparison viewer
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            Source overlay before registration. Use alignment review to inspect
            the registered result.
          </p>
        </div>
        <label className="flex min-w-52 items-center gap-3 text-sm text-stone-700">
          <span>Cleaned opacity</span>
          <input
            aria-label="Cleaned image opacity"
            className="w-28 accent-indigo-700"
            disabled={!cleaned}
            max={100}
            min={0}
            onChange={(event) =>
              onOpacityChange(Number(event.currentTarget.value) / 100)
            }
            type="range"
            value={Math.round(opacity * 100)}
          />
          <span className="w-9 tabular-nums">{Math.round(opacity * 100)}%</span>
        </label>
      </div>
      {original && cleaned && dimensionsMatch === false && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Image dimensions differ. This source overlay centers and scales each
          image for viewing; it does not register or align them.
        </p>
      )}
      <ImageCanvas
        comparison
        layers={layers}
        title="Original and cleaned page overlay"
        toolbar
      />
    </section>
  );
}

function ImageCanvas({
  title,
  layers,
  comparison = false,
  toolbar = true,
}: ImageCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; pan: PanState } | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    width: 0,
    height: 0,
  });
  const [zoomFactor, setZoomFactor] = useState(1);
  const [pan, setPan] = useState<PanState>({ x: 0, y: 0 });
  const hasLayers = layers.length > 0;
  const baseWidth = comparison
    ? Math.max(0, ...layers.map((layer) => layer.metadata.dimensions.width))
    : (layers[0]?.metadata.dimensions.width ?? 0);
  const baseHeight = comparison
    ? Math.max(0, ...layers.map((layer) => layer.metadata.dimensions.height))
    : (layers[0]?.metadata.dimensions.height ?? 0);
  const fitScale =
    viewport.width > 0 && viewport.height > 0 && baseWidth > 0 && baseHeight > 0
      ? Math.min(viewport.width / baseWidth, viewport.height / baseHeight)
      : 1;
  const scale = fitScale * zoomFactor;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoomFactor(1);
    setPan({ x: 0, y: 0 });
  }, [baseWidth, baseHeight]);

  function fitToViewport() {
    setZoomFactor(1);
    setPan({ x: 0, y: 0 });
  }

  function showActualSize() {
    setZoomFactor(1 / fitScale);
    setPan({ x: 0, y: 0 });
  }

  function zoomBy(multiplier: number) {
    setZoomFactor((current) =>
      Math.min(40, Math.max(0.02, current * multiplier)),
    );
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!hasLayers || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, pan };
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.pan.x + event.clientX - dragRef.current.x,
      y: dragRef.current.pan.y + event.clientY - dragRef.current.y,
    });
  }

  function finishPan() {
    dragRef.current = null;
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!hasLayers) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
        <h2 className="font-semibold text-stone-900">{title}</h2>
        {toolbar && (
          <div className="flex items-center gap-1">
            <button
              aria-label="Zoom out"
              className="viewer-button"
              disabled={!hasLayers}
              onClick={() => zoomBy(1 / 1.25)}
              type="button"
            >
              −
            </button>
            <button
              aria-label="Fit image"
              className="viewer-button px-3"
              disabled={!hasLayers}
              onClick={fitToViewport}
              type="button"
            >
              Fit
            </button>
            <button
              aria-label="Show image at 100 percent"
              className="viewer-button px-3"
              disabled={!hasLayers}
              onClick={showActualSize}
              type="button"
            >
              100%
            </button>
            <button
              aria-label="Zoom in"
              className="viewer-button"
              disabled={!hasLayers}
              onClick={() => zoomBy(1.25)}
              type="button"
            >
              +
            </button>
            <span className="ml-2 w-12 text-right text-xs tabular-nums text-stone-500">
              {Math.round(scale * 100)}%
            </span>
          </div>
        )}
      </div>
      <div
        aria-label={title}
        className={`image-viewport ${comparison ? 'comparison-canvas' : ''} ${hasLayers ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onPointerCancel={finishPan}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={finishPan}
        onWheel={handleWheel}
        ref={viewportRef}
        role="img"
      >
        {!hasLayers && (
          <p className="px-6 text-center text-sm text-stone-500">
            Import an image to view this page.
          </p>
        )}
        {layers.map((layer) => {
          const imageSpace: ImageSpace = createImageSpace(
            `image:${layer.metadata.id}`,
            layer.metadata.dimensions.width,
            layer.metadata.dimensions.height,
          );
          const displaySpace = createDisplaySpace({
            id: `display:${title}:${layer.metadata.id}`,
            dimensions: {
              width: Math.max(1, viewport.width),
              height: Math.max(1, viewport.height),
            },
            imageSpace,
            fitScale,
            zoom: zoomFactor,
            origin: {
              x:
                (viewport.width - layer.metadata.dimensions.width * fitScale) /
                2,
              y:
                (viewport.height -
                  layer.metadata.dimensions.height * fitScale) /
                2,
            },
            pan,
          });
          const imageTopLeft = imageToDisplay(
            { x: -0.5, y: -0.5, coordinateSpace: imageSpace },
            displaySpace,
          );
          return (
            <img
              alt={`${layer.role === 'original' ? 'Original' : 'Cleaned'} comic page`}
              className="image-layer"
              draggable={false}
              key={layer.role}
              src={layer.src}
              style={{
                height: layer.metadata.dimensions.height,
                left: 0,
                opacity: layer.opacity ?? 1,
                top: 0,
                transform: `translate(${imageTopLeft.x + 0.5}px, ${imageTopLeft.y + 0.5}px) scale(${scale})`,
                transformOrigin: 'top left',
                width: layer.metadata.dimensions.width,
              }}
            />
          );
        })}
      </div>
      {layers[0] && <ImageDetails metadata={layers[0].metadata} />}
    </section>
  );
}

function ImageDetails({
  metadata,
}: {
  readonly metadata: SourceImageMetadata;
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-stone-100 px-4 py-3 text-xs sm:grid-cols-4">
      <div className="min-w-0">
        <dt className="text-stone-500">Filename</dt>
        <dd
          className="truncate font-medium text-stone-800"
          title={metadata.filename}
        >
          {metadata.filename}
        </dd>
      </div>
      <div>
        <dt className="text-stone-500">Dimensions</dt>
        <dd className="font-medium text-stone-800">
          {metadata.dimensions.width} × {metadata.dimensions.height}
        </dd>
      </div>
      <div>
        <dt className="text-stone-500">Format</dt>
        <dd className="font-medium text-stone-800">{metadata.format}</dd>
      </div>
      <div>
        <dt className="text-stone-500">Size</dt>
        <dd className="font-medium text-stone-800">
          {formatBytes(metadata.sizeBytes)}
        </dd>
      </div>
    </dl>
  );
}

export function App() {
  const [projectService] = useState(
    () => new ProjectService(new IndexedDbProjectRepository()),
  );
  const [activeProject, setActiveProject] = useState<ProjectSnapshot | null>(
    null,
  );
  const [savedProjects, setSavedProjects] = useState<
    readonly Pick<ProjectSnapshot, 'id' | 'name' | 'updatedAt' | 'revision'>[]
  >([]);
  const [projectMessage, setProjectMessage] = useState<string | null>(null);
  const [sourceBlobs, setSourceBlobs] = useState<
    Partial<Record<SourceImageRole, Blob>>
  >({});
  const [editorDocument, setEditorDocument] = useState<EditorDocument | null>(
    null,
  );
  const [loadedEditorDocument, setLoadedEditorDocument] =
    useState<EditorDocument | null>(null);
  const editorDocumentRef = useRef<EditorDocument | null>(null);
  const [savedTranscript, setSavedTranscript] = useState<Transcript | null>(
    null,
  );
  const [audioClock, setAudioClock] = useState<ClockSnapshot>({
    positionSeconds: 0,
    durationSeconds: 0,
    playbackRate: 1,
    status: 'empty',
  });
  const audioControlsRef = useRef<AudioPlaybackControls | null>(null);
  const [seekRequest, setSeekRequest] = useState<{
    readonly time: number;
    readonly revision: number;
  } | null>(null);
  const [mappingCommand, setMappingCommand] = useState<{
    readonly revision: number;
    readonly transcriptSegmentId: string;
    readonly bubbleId: string;
    readonly caption: string;
    readonly start: number;
    readonly end: number;
  } | null>(null);
  const [mappingChoices, setMappingChoices] = useState<Record<string, string>>(
    {},
  );
  const [dismissedMappingIds, setDismissedMappingIds] = useState<
    readonly string[]
  >([]);
  const [audioSource, setAudioSource] = useState<{
    readonly metadata: Record<string, unknown>;
    readonly blob: Blob;
  } | null>(null);
  const [loadedAudioFile, setLoadedAudioFile] = useState<File | null>(null);
  const [audioSessionRevision, setAudioSessionRevision] = useState(0);
  const [mp4Resolution, setMp4Resolution] = useState<Mp4Resolution>('720p');
  const [customVideoWidth, setCustomVideoWidth] = useState('1280');
  const [customVideoHeight, setCustomVideoHeight] = useState('720');
  const [mp4Progress, setMp4Progress] = useState<Mp4ExportProgress | null>(
    null,
  );
  const [mp4Exporting, setMp4Exporting] = useState(false);
  const mp4AbortRef = useRef<AbortController | null>(null);
  const projectImportRef = useRef<HTMLInputElement>(null);
  const [pair, setPair] = useState<ImagePair>(emptyPair);
  const [sourceUrls, setSourceUrls] = useState<
    Partial<Record<SourceImageRole, string>>
  >({});
  const [opacity, setOpacity] = useState(0.5);
  const [busyRole, setBusyRole] = useState<SourceImageRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alignment, setAlignment] = useState<AlignmentResult | null>(null);
  const [alignmentImages, setAlignmentImages] =
    useState<AlignmentImages | null>(null);
  const [alignmentMode, setAlignmentMode] = useState<'overlay' | 'difference'>(
    'overlay',
  );
  const [alignmentBusy, setAlignmentBusy] = useState(false);
  const [textRegions, setTextRegions] = useState<readonly TextRegion[]>([]);
  const [textDebugUrl, setTextDebugUrl] = useState<string | null>(null);
  const [textDetectionBusy, setTextDetectionBusy] = useState(false);
  const [pageAnalysis, setPageAnalysis] = useState<{
    readonly bubbles: readonly {
      readonly id: string;
      readonly kind: 'speech' | 'thought' | 'narration' | 'unknown';
      readonly confidence: number;
      readonly classificationConfidence?: number;
      readonly detectionSources?: readonly (
        | 'detected'
        | 'ml'
        | 'heuristic'
      )[];
      readonly polygon: {
        readonly points: readonly { readonly x: number; readonly y: number }[];
      };
      readonly tail?:
        readonly { readonly x: number; readonly y: number }[] | null;
    }[];
    readonly ocr: {
      readonly blocks: readonly {
        readonly lines: readonly {
          readonly id: string;
          readonly text: string;
          readonly confidence: number;
          readonly boundingBox: {
            readonly x: number;
            readonly y: number;
            readonly width: number;
            readonly height: number;
          };
        }[];
      }[];
    };
  } | null>(null);
  const [pageAnalysisBusy, setPageAnalysisBusy] = useState(false);
  const [autoCleanBusy, setAutoCleanBusy] = useState(false);
  const [readingDirection, setReadingDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [bubbleProposalSource, setBubbleProposalSource] = useState<
    'heuristic' | 'ml'
  >('ml');
  const [readingOrder, setReadingOrder] = useState<readonly string[] | null>(
    null,
  );
  const [ocrReviewItems, setOcrReviewItems] = useState<
    readonly {
      readonly id: string;
      readonly text: string;
      readonly confidence: number;
      readonly reason: string;
    }[]
  >([]);
  const [ocrDocument, setOcrDocument] = useState<OCRDocument | null>(null);
  const [ocrStatus, setOcrStatus] = useState<PaddleOCRStatus | null>(null);
  const ocrRequestIdRef = useRef(0);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const [ocrMetrics, setOcrMetrics] = useState<{
    readonly initializationMs: number;
    readonly detectionMs: number;
    readonly recognitionMs: number;
    readonly totalMs: number;
    readonly detectedTextRegions: number;
    readonly averageConfidence: number;
  } | null>(null);
  const [speechAutomationBusy, setSpeechAutomationBusy] = useState(false);
  const [speechProposals, setSpeechProposals] = useState<
    readonly SpeechAutomationMatch[] | null
  >(null);
  const [speechAutomationWarning, setSpeechAutomationWarning] = useState<
    string | null
  >(null);
  const alignmentImagesRef = useRef(alignmentImages);
  alignmentImagesRef.current = alignmentImages;
  const textDebugUrlRef = useRef(textDebugUrl);
  textDebugUrlRef.current = textDebugUrl;
  const urlRef = useRef(sourceUrls);
  urlRef.current = sourceUrls;
  editorDocumentRef.current = editorDocument;

  useEffect(() => {
    void projectService
      .list()
      .then(setSavedProjects)
      .catch((cause: unknown) =>
        setProjectMessage(
          cause instanceof Error
            ? cause.message
            : 'Local project storage is unavailable.',
        ),
      );
  }, [projectService]);

  useEffect(() => {
    let cancelled = false;
    async function restoreCurrentImports() {
      try {
        const response = await fetch('/api/images');
        if (!response.ok) return;
        const current = (await response.json()) as ImagePair;
        if (cancelled) return;
        setPair(current);
        for (const role of ['original', 'cleaned'] as const) {
          if (!current[role]) continue;
          const content = await fetch(`/api/images/${role}/content`);
          if (!content.ok || cancelled) continue;
          const sourceBlob = await content.blob();
          setSourceUrls((previous) => {
            const oldUrl = previous[role];
            if (oldUrl) URL.revokeObjectURL(oldUrl);
            return { ...previous, [role]: URL.createObjectURL(sourceBlob) };
          });
          setSourceBlobs((previous) => ({ ...previous, [role]: sourceBlob }));
        }
        if (!cancelled) {
          const savedAlignment = await fetch('/api/alignment');
          if (savedAlignment.ok) {
            setAlignment((await savedAlignment.json()) as AlignmentResult);
            await loadAlignmentImages();
          }
        }
      } catch {
        // The UI remains usable when the API is not running during static preview.
      }
    }
    void restoreCurrentImports();
    return () => {
      cancelled = true;
      Object.values(urlRef.current).forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
      if (alignmentImagesRef.current) {
        URL.revokeObjectURL(alignmentImagesRef.current.overlay);
        URL.revokeObjectURL(alignmentImagesRef.current.difference);
      }
      if (textDebugUrlRef.current) URL.revokeObjectURL(textDebugUrlRef.current);
    };
  }, []);

  async function importImage(role: SourceImageRole, file?: File) {
    if (!file) return;
    ocrAbortRef.current?.abort();
    ocrAbortRef.current = null;
    ocrRequestIdRef.current += 1;
    setOcrStatus(null);
    setBusyRole(role);
    setError(null);
    try {
      const form = new FormData();
      form.set('image', file);
      const response = await fetch(`/api/images/${role}`, {
        method: 'POST',
        body: form,
      });
      const result = (await response.json()) as {
        readonly image?: SourceImageMetadata;
        readonly pair?: ImagePair;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !result.image || !result.pair) {
        throw new Error(
          result.error?.message ?? 'The image could not be imported.',
        );
      }
      // The import can finish after a new OCR request starts on the previous page.
      ocrRequestIdRef.current += 1;
      setPair(result.pair);
      setAlignment(null);
      setPageAnalysis(null);
      setOcrDocument(null);
      setOcrStatus(null);
      setOcrMetrics(null);
      setSpeechProposals(null);
      setSpeechAutomationWarning(null);
      setTextRegions([]);
      setTextDebugUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
      setAlignmentImages((previous) => {
        if (previous) {
          URL.revokeObjectURL(previous.overlay);
          URL.revokeObjectURL(previous.difference);
        }
        return null;
      });
      setSourceUrls((previous) => {
        const oldUrl = previous[role];
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        return { ...previous, [role]: URL.createObjectURL(file) };
      });
      setSourceBlobs((previous) => ({ ...previous, [role]: file }));
      // Original-only workflow: synthesize a cleaned page immediately so the
      // user never has to hand-prep one. A later hand-imported cleaned page
      // still overrides this result.
      if (role === 'original' && needsAutoClean(result.pair)) {
        void ensureCleanedPage({ file, metadata: result.image });
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The image could not be imported.',
      );
    } finally {
      setBusyRole(null);
    }
  }

  /**
   * Auto-inpaint: erase bubble text from the original page so users can skip
   * hand-preparing a cleaned page. The original+cleaned path stays available
   * as a pro override.
   */
  async function autoCleanFromOriginal(overrides?: {
    readonly file?: File;
    readonly metadata?: SourceImageMetadata;
  }): Promise<boolean> {
    const file = overrides?.file ?? sourceBlobs.original;
    const metadata = overrides?.metadata ?? pair.original;
    if (!file || !metadata) return false;
    setAutoCleanBusy(true);
    setError(null);
    try {
      const raster = await rasterFromImageSource(file);
      // First pass: detect bubbles so inpaint can localize text regions.
      const detection = await detectBubblesHybrid(
        new Uint8Array(await file.arrayBuffer()),
        createImageSpace(
          `workspace:${metadata.id}`,
          metadata.dimensions.width,
          metadata.dimensions.height,
        ),
        {
          proposalSource:
            bubbleProposalSource === 'ml'
              ? { kind: 'yolo-onnx' }
              : { kind: 'heuristic' },
        },
      );
      const bubbles = detection.bubbles.map((hybrid) => ({
        id: hybrid.bubble.id,
        contour: hybrid.bubble.contour,
      }));
      const textObservations = ocrDocument
        ? ocrDocument.blocks.flatMap((block) =>
            block.lines.map((line) => ({
              id: line.id,
              polygon: {
                points: [
                  {
                    x: line.boundingBox.x,
                    y: line.boundingBox.y,
                    coordinateSpace: line.coordinateSpace,
                  },
                  {
                    x: line.boundingBox.x + line.boundingBox.width,
                    y: line.boundingBox.y,
                    coordinateSpace: line.coordinateSpace,
                  },
                  {
                    x: line.boundingBox.x + line.boundingBox.width,
                    y: line.boundingBox.y + line.boundingBox.height,
                    coordinateSpace: line.coordinateSpace,
                  },
                  {
                    x: line.boundingBox.x,
                    y: line.boundingBox.y + line.boundingBox.height,
                    coordinateSpace: line.coordinateSpace,
                  },
                ],
                coordinateSpace: line.coordinateSpace,
              },
            })),
          )
        : undefined;
      const result = autoCleanPage(raster, bubbles, textObservations);
      const cleanedBlob = await rasterToPngBlob(result.cleaned);
      const cleanedFile = new File(
        [cleanedBlob],
        `auto-cleaned-${metadata.filename ?? 'page.png'}`,
        { type: 'image/png' },
      );
      // Import through the same path as a hand-prepared cleaned page.
      const form = new FormData();
      form.set('image', cleanedFile);
      const response = await fetch('/api/images/cleaned', {
        method: 'POST',
        body: form,
      });
      const imported = (await response.json()) as {
        readonly image?: SourceImageMetadata;
        readonly pair?: ImagePair;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !imported.image || !imported.pair) {
        throw new Error(
          imported.error?.message ?? 'Auto-cleaned page could not be imported.',
        );
      }
      setPair(imported.pair);
      setSourceBlobs((previous) => ({ ...previous, cleaned: cleanedFile }));
      setSourceUrls((previous) => {
        if (previous.cleaned) URL.revokeObjectURL(previous.cleaned);
        return {
          ...previous,
          cleaned: URL.createObjectURL(cleanedFile),
        };
      });
      setProjectMessage(
        `Auto-clean erased ${result.erasedPixelCount.toLocaleString()} text pixels across ${result.masks.length} bubble region(s). Review the cleaned page, or import a hand-prepared cleaned page to override.`,
      );
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Auto-clean failed. Import a cleaned page manually instead.',
      );
      return false;
    } finally {
      setAutoCleanBusy(false);
    }
  }

  /**
   * Guarantee a cleaned page exists. If the user only imported the original,
   * auto-inpaint synthesizes one so the rest of the pipeline (scan, map,
   * export) does not require a hand-prepared cleaned page.
   */
  async function ensureCleanedPage(overrides?: {
    readonly file?: File;
    readonly metadata?: SourceImageMetadata;
  }): Promise<boolean> {
    if (overrides?.file && overrides?.metadata) {
      return autoCleanFromOriginal(overrides);
    }
    if (!needsAutoClean(pair)) return Boolean(pair.cleaned || pair.original);
    return autoCleanFromOriginal();
  }

  async function loadAlignmentImages() {
    const [overlayResponse, differenceResponse] = await Promise.all([
      fetch('/api/alignment/visualization/overlay'),
      fetch('/api/alignment/visualization/difference'),
    ]);
    if (!overlayResponse.ok || !differenceResponse.ok) {
      throw new Error('The alignment visualizations could not be loaded.');
    }
    const next = {
      overlay: URL.createObjectURL(await overlayResponse.blob()),
      difference: URL.createObjectURL(await differenceResponse.blob()),
    };
    setAlignmentImages((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous.overlay);
        URL.revokeObjectURL(previous.difference);
      }
      return next;
    });
  }

  async function runAlignment() {
    setAlignmentBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/alignment', { method: 'POST' });
      const result = (await response.json()) as {
        readonly error?: { readonly message?: string };
      } & Partial<AlignmentResult>;
      if (!response.ok || !result.sourceSpace || !result.targetSpace) {
        throw new Error(
          result.error?.message ?? 'The images could not be aligned.',
        );
      }
      setAlignment(result as AlignmentResult);
      ocrAbortRef.current?.abort();
      ocrRequestIdRef.current += 1;
      setOcrStatus(null);
      setPageAnalysis(null);
      setOcrDocument(null);
      setOcrMetrics(null);
      setSpeechProposals(null);
      setSpeechAutomationWarning(null);
      setTextRegions([]);
      setTextDebugUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
      setAlignmentMode('overlay');
      await loadAlignmentImages();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The images could not be aligned.',
      );
    } finally {
      setAlignmentBusy(false);
    }
  }

  async function saveManualAlignment(parameters: {
    readonly scale: number;
    readonly rotation: number;
    readonly translationX: number;
    readonly translationY: number;
  }) {
    const response = await fetch('/api/alignment/manual', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parameters),
    });
    const result = (await response.json()) as {
      readonly error?: { readonly message?: string };
    } & Partial<AlignmentResult>;
    if (!response.ok || !result.sourceSpace || !result.targetSpace) {
      throw new Error(
        result.error?.message ?? 'The manual correction could not be saved.',
      );
    }
    setAlignment(result as AlignmentResult);
    ocrAbortRef.current?.abort();
    ocrRequestIdRef.current += 1;
    setOcrStatus(null);
    setPageAnalysis(null);
    setOcrDocument(null);
    setOcrMetrics(null);
    setSpeechProposals(null);
    setSpeechAutomationWarning(null);
    setTextRegions([]);
    setTextDebugUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    await loadAlignmentImages();
  }

  async function detectRemovedText() {
    setTextDetectionBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/text-differences', { method: 'POST' });
      const result = (await response.json()) as {
        readonly regions?: readonly TextRegion[];
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !result.regions) {
        throw new Error(
          result.error?.message ?? 'Removed text could not be detected.',
        );
      }
      const debugResponse = await fetch('/api/text-differences/debug');
      if (!debugResponse.ok)
        throw new Error('The text-difference debug image could not be loaded.');
      const debugUrl = URL.createObjectURL(await debugResponse.blob());
      setTextDebugUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return debugUrl;
      });
      setTextRegions(result.regions);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Removed text could not be detected.',
      );
    } finally {
      setTextDetectionBusy(false);
    }
  }

  async function ensurePageImageSession() {
    if (
      (!sourceBlobs.original || !pair.original) &&
      (!sourceBlobs.cleaned || !pair.cleaned)
    )
      throw new Error(
        'Import a comic page before scanning or extracting text.',
      );
    const imageResponse = await fetch('/api/images');
    if (!imageResponse.ok)
      throw new Error('The image-processing server did not respond.');
    let currentImages = (await imageResponse.json()) as ImagePair;
    for (const role of ['original', 'cleaned'] as const) {
      const file = sourceBlobs[role];
      const metadata = pair[role];
      if (!file || !metadata || currentImages[role]?.sha256 === metadata.sha256)
        continue;
      const form = new FormData();
      form.set('image', file, metadata.filename);
      const uploaded = await fetch(`/api/images/${role}`, {
        method: 'POST',
        body: form,
      });
      const uploadResult = (await uploaded.json()) as {
        readonly error?: { readonly message?: string };
      };
      if (!uploaded.ok)
        throw new Error(
          uploadResult.error?.message ?? `Could not upload the ${role} page.`,
        );
      currentImages = (await (await fetch('/api/images')).json()) as ImagePair;
    }
    if (pair.original && pair.cleaned) {
      let response = await fetch('/api/alignment');
      if (!response.ok)
        response = await fetch('/api/alignment', { method: 'POST' });
      let result = (await response.json()) as Partial<AlignmentResult> & {
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !result.sourceSpace || !result.targetSpace)
        throw new Error(
          result.error?.message ?? 'Align both pages before scanning bubbles.',
        );
      if (alignment?.method === 'manual' && result.method !== 'manual') {
        response = await fetch('/api/alignment/manual', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scale: alignment.scale,
            rotation: alignment.rotation,
            translationX: alignment.translation.x,
            translationY: alignment.translation.y,
          }),
        });
        result = (await response.json()) as typeof result;
        if (!response.ok || !result.sourceSpace || !result.targetSpace)
          throw new Error(
            result.error?.message ??
              'The manual alignment could not be applied.',
          );
      }
      setAlignment(result as AlignmentResult);
    }
  }

  async function detectBubbles() {
    await ensurePageImageSession();
    const alignPair = Boolean(pair.original && pair.cleaned);
    const response = await fetch('/api/analyze-page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: pair.cleaned ? 'cleaned' : 'original',
        alignPair,
      }),
    });
    const result = (await response.json()) as NonNullable<
      typeof pageAnalysis
    > & {
      readonly error?: { readonly message?: string };
    };
    if (!response.ok || !result?.bubbles || !result.ocr)
      throw new Error(result?.error?.message ?? 'Bubble detection failed.');

    // Hybrid recall boost: heuristic proposals + deterministic geometry.
    // Also derive panel reading order (LTR/RTL) for mapping.
    let bubbles = result.bubbles;
    let order: readonly string[] | null = null;
    const role = pair.cleaned ? 'cleaned' : 'original';
    const pageBlob = sourceBlobs[role];
    const pageMeta = pair[role];
    if (pageBlob && pageMeta) {
      try {
        const space = createImageSpace(
          `workspace:${pageMeta.id}`,
          pageMeta.dimensions.width,
          pageMeta.dimensions.height,
        );
        const pageBytes = new Uint8Array(await pageBlob.arrayBuffer());
        const hybrid = await detectBubblesHybrid(pageBytes, space, {
          proposalSource:
            bubbleProposalSource === 'ml'
              ? { kind: 'yolo-onnx' }
              : { kind: 'heuristic' },
        });
        if (hybrid.bubbles.length > 0) {
          bubbles = hybrid.bubbles.map((hybridBubble) => ({
            id: hybridBubble.bubble.id,
            kind: hybridBubble.bubble.kind,
            confidence: hybridBubble.bubble.confidence,
            ...(hybridBubble.bubble.classificationConfidence !== undefined
              ? {
                  classificationConfidence:
                    hybridBubble.bubble.classificationConfidence,
                }
              : {}),
            detectionSources: [...hybridBubble.sources] as (
              | 'detected'
              | 'ml'
              | 'heuristic'
            )[],
            polygon: { points: hybridBubble.bubble.polygon.points },
            tail: hybridBubble.bubble.tail ?? null,
            reviewStatus: 'pending-review' as const,
          })) as typeof bubbles;
          setProjectMessage(
            `Hybrid detection: ${hybrid.result.deterministicCount} deterministic, ` +
              `${hybrid.result.proposalCount} proposals, ` +
              `${hybrid.result.mergedCount} merged, ` +
              `${hybrid.result.refinedCount} refined` +
              (hybrid.provider ? ` (${hybrid.provider}).` : '.'),
          );
        }
        const panelOrder = await detectPanelsAndOrder(
          pageBytes,
          space,
          bubbles.map((bubble) => {
            const xs = bubble.polygon.points.map((point) => point.x);
            const ys = bubble.polygon.points.map((point) => point.y);
            return {
              id: bubble.id,
              boundingBox: {
                x: Math.min(...xs),
                y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
                coordinateSpace: space,
              },
            };
          }),
          readingDirection,
        );
        order = panelOrder.readingOrder;
        setReadingOrder(order);
      } catch {
        // Hybrid/panel analysis is an enhancement; keep server bubbles if it fails.
      }
    }

    setPageAnalysis((previous) => ({
      bubbles,
      ocr: previous?.ocr ?? result.ocr,
    }));
    setProjectMessage(
      order
        ? `Bubble scan found ${bubbles.length} candidates (reading order: ${order.length} panels/bubbles, ${readingDirection.toUpperCase()}). Review regions on the comic canvas.`
        : `Bubble scan found ${bubbles.length} candidates. Review and select regions on the comic canvas.`,
    );
    return { ...result, bubbles };
  }

  async function extractPageText(
    suppliedBubbles?: readonly Parameters<
      typeof recognizeComicBubbles
    >[1][number][],
    enhanced = false,
  ) {
    await ensurePageImageSession();
    const role = sourceBlobs.original && pair.original ? 'original' : 'cleaned';
    const image = sourceBlobs[role];
    const metadata = pair[role];
    if (!image || !metadata)
      throw new Error('Import a comic page before running local OCR.');
    const imageSpace = createImageSpace(
      `workspace:${metadata.id}`,
      metadata.dimensions.width,
      metadata.dimensions.height,
    );
    const requestId = ++ocrRequestIdRef.current;
    ocrAbortRef.current?.abort();
    const abortController = new AbortController();
    ocrAbortRef.current = abortController;
    const reportOCRStatus = (status: PaddleOCRStatus) => {
      if (ocrRequestIdRef.current === requestId) setOcrStatus(status);
    };
    const textRegionCrops = enhanced
      ? textRegions.map((region) => ({
          id: `text-region-${region.id}`,
          cropPadding: 0.24,
          polygon: [
            { x: region.boundingBox.x, y: region.boundingBox.y },
            {
              x: region.boundingBox.x + region.boundingBox.width,
              y: region.boundingBox.y,
            },
            {
              x: region.boundingBox.x + region.boundingBox.width,
              y: region.boundingBox.y + region.boundingBox.height,
            },
            {
              x: region.boundingBox.x,
              y: region.boundingBox.y + region.boundingBox.height,
            },
          ],
        }))
      : [];
    const bubbleRegions =
      suppliedBubbles ??
      (editorDocument && Object.keys(editorDocument.bubbles).length > 0
        ? Object.values(editorDocument.bubbles).map((bubble) => ({
            id: bubble.id,
            polygon: bubble.polygon.points,
            tail: bubble.tail?.points ?? null,
            ...(bubble.reviewStatus
              ? { reviewStatus: bubble.reviewStatus }
              : {}),
          }))
        : (pageAnalysis?.bubbles ?? []).map((bubble) => ({
            id: bubble.id,
            polygon: bubble.polygon.points,
            tail: bubble.tail ?? null,
            reviewStatus: 'pending-review',
          })));
    // Bubble crops retain visual context. Tight text-region crops are a useful
    // fallback when no bubbles are available, but can clip punctuation/strokes.
    const cropRegions = bubbleRegions.length ? bubbleRegions : textRegionCrops;
    let recognized: Awaited<ReturnType<typeof recognizeComicPage>>;
    try {
      recognized = cropRegions.length
        ? await recognizeComicBubbles(
            { role, sha256: metadata.sha256, imageSpace },
            cropRegions,
            reportOCRStatus,
            enhanced,
            abortController.signal,
          )
        : await recognizeComicPage(
            { role, sha256: metadata.sha256, imageSpace },
            reportOCRStatus,
            enhanced,
            abortController.signal,
          );
      if (ocrRequestIdRef.current !== requestId)
        throw new DOMException(
          'The active comic page changed while OCR was running.',
          'AbortError',
        );
    } catch (cause) {
      if (ocrRequestIdRef.current === requestId)
        setOcrStatus({
          phase: 'error',
          message:
            cause instanceof Error
              ? `PaddleOCR could not finish: ${cause.message}`
              : 'PaddleOCR could not finish this page.',
        });
      throw cause;
    } finally {
      if (ocrAbortRef.current === abortController) ocrAbortRef.current = null;
    }
    const ocr = {
      coordinateSpace: imageSpace,
      blocks: recognized.document.blocks.map((block) => ({
        lines: block.lines.map((line) => ({
          id: line.id,
          text: line.text,
          confidence: line.confidence,
          boundingBox: line.boundingBox,
        })),
      })),
    };
    setPageAnalysis((previous) => ({ bubbles: previous?.bubbles ?? [], ocr }));
    setOcrDocument(recognized.document);
    setOcrMetrics(recognized.metrics);
    // Confidence triage: only uncertain words/lines need review.
    try {
      const triage = triageOcrDocument(recognized.document, {
        confidenceThreshold: 0.85,
        maxItems: 40,
      });
      setOcrReviewItems(
        triage.reviewItems.map((item) => ({
          id: item.id,
          text: item.text,
          confidence: item.confidence,
          reason:
            item.reason === 'pass-disagreement'
              ? 'OCR passes disagreed on this text.'
              : `Confidence ${Math.round(item.confidence * 100)}% is below the review threshold.`,
        })),
      );
      const uncertain = triage.summary.uncertainCount;
      setProjectMessage(
        `${enhanced ? (bubbleRegions.length ? 'Enhanced bubble-crop OCR' : textRegionCrops.length ? 'Enhanced text-region OCR' : 'Enhanced page OCR') : bubbleRegions.length ? 'Bubble-crop OCR' : 'Page OCR'} found ${recognized.metrics.detectedTextRegions} text regions in ${Math.round(recognized.metrics.totalMs)} ms${uncertain > 0 ? ` · ${uncertain} uncertain item(s) queued for review` : ' · all text is high-confidence'}.`,
      );
    } catch {
      setProjectMessage(
        `${enhanced ? (bubbleRegions.length ? 'Enhanced bubble-crop OCR' : textRegionCrops.length ? 'Enhanced text-region OCR' : 'Enhanced page OCR') : bubbleRegions.length ? 'Bubble-crop OCR' : 'Page OCR'} found ${recognized.metrics.detectedTextRegions} text regions in ${Math.round(recognized.metrics.totalMs)} ms. Review the extracted text on the canvas and in each bubble.`,
      );
    }
    return recognized.document;
  }

  async function requestPageAnalysis() {
    await ensurePageImageSession();
    if (!pageAnalysis?.bubbles.length) await detectBubbles();
    return extractPageText();
  }

  async function analyzePage() {
    setPageAnalysisBusy(true);
    setError(null);
    try {
      await detectBubbles();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Page analysis failed.',
      );
    } finally {
      setPageAnalysisBusy(false);
    }
  }

  async function extractText() {
    setError(null);
    try {
      await extractPageText();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Local OCR failed.');
    }
  }

  async function retryEnhancedOCR() {
    setError(null);
    try {
      await extractPageText(undefined, true);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Enhanced OCR failed.');
    }
  }

  async function scanAndExtract() {
    setPageAnalysisBusy(true);
    setError(null);
    try {
      const detection = await detectBubbles();
      await extractPageText(
        detection.bubbles.map((bubble) => ({
          id: bubble.id,
          polygon: bubble.polygon.points,
          tail: bubble.tail ?? null,
          reviewStatus: 'pending-review',
        })),
      );
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(
        cause instanceof Error ? cause.message : 'Comic page scan failed.',
      );
    } finally {
      setPageAnalysisBusy(false);
    }
  }

  async function automateSpeech() {
    if (!pair.original && !pair.cleaned) return;
    if (!sourceBlobs.original && !sourceBlobs.cleaned) return;
    setSpeechAutomationBusy(true);
    setError(null);
    setSpeechProposals(null);
    setSpeechAutomationWarning(null);
    try {
      // Original-only workflow: synthesize a cleaned page when needed.
      const cleanedReady = await ensureCleanedPage();
      if (!cleanedReady) {
        throw new Error(
          'Auto-clean could not prepare a cleaned page. Import one manually to continue.',
        );
      }
      await ensureAutomationApiSession();
      const pageOCR = ocrDocument ?? (await requestPageAnalysis());
      const transcript =
        savedTranscript ?? (await audioControlsRef.current?.transcribe());
      if (!transcript)
        throw new Error(
          'Could not create a transcript from the imported audio. Check the Audio track message and try again.',
        );
      setSavedTranscript(transcript);
      const response = await fetch('/api/automate-speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transcript, ocr: pageOCR }),
      });
      const result = (await response.json()) as {
        readonly bubbles?: NonNullable<typeof pageAnalysis>['bubbles'];
        readonly ocr?: NonNullable<typeof pageAnalysis>['ocr'];
        readonly matches?: readonly SpeechAutomationMatch[];
        readonly ocrWarning?: string | null;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !result.bubbles || !result.ocr || !result.matches)
        throw new Error(result.error?.message ?? 'Speech automation failed.');
      setPageAnalysis({ bubbles: result.bubbles, ocr: result.ocr });
      setSpeechProposals(result.matches);
      setSpeechAutomationWarning(result.ocrWarning ?? null);
      setDismissedMappingIds([]);
      setMappingChoices({});
      setProjectMessage(
        `Speech automation found ${result.matches.length} dialogue turns. Review bubble matches and fitted captions below.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Speech automation failed.',
      );
    } finally {
      setSpeechAutomationBusy(false);
    }
  }

  async function ensureAutomationApiSession() {
    if (!pair.original && !pair.cleaned)
      throw new Error('Import a comic page before running speech automation.');
    if (!sourceBlobs.original && !sourceBlobs.cleaned)
      throw new Error('Import a comic page before running speech automation.');
    // Prefer a cleaned page (auto-inpaint when only the original is present).
    if (!pair.cleaned || !sourceBlobs.cleaned) {
      const cleanedReady = await ensureCleanedPage();
      if (!cleanedReady || !pair.cleaned || !sourceBlobs.cleaned)
        throw new Error(
          'Auto-clean could not prepare a cleaned page. Import the original and cleaned pages, then try again.',
        );
    }
    const imageResponse = await fetch('/api/images');
    if (!imageResponse.ok)
      throw new Error(
        'The image-processing server did not respond. Restart the API server and try again.',
      );
    const currentImages = (await imageResponse.json()) as ImagePair;
    const serverHasPair =
      pair.original != null &&
      pair.cleaned != null &&
      currentImages.original?.sha256 === pair.original.sha256 &&
      currentImages.cleaned?.sha256 === pair.cleaned.sha256;
    if (!serverHasPair) {
      for (const role of ['original', 'cleaned'] as const) {
        const file = sourceBlobs[role];
        const metadata = pair[role];
        if (!file || !metadata)
          throw new Error(
            `The ${role} page file is missing. Reimport it and try again.`,
          );
        const form = new FormData();
        form.set('image', file, metadata.filename);
        const uploaded = await fetch(`/api/images/${role}`, {
          method: 'POST',
          body: form,
        });
        const uploadResult = (await uploaded.json()) as {
          readonly error?: { readonly message?: string };
        };
        if (!uploaded.ok)
          throw new Error(
            uploadResult.error?.message ??
              `Could not reconnect the ${role} page to the image-processing server.`,
          );
      }
    }
    let alignmentResponse = serverHasPair
      ? await fetch('/api/alignment')
      : null;
    if (!alignmentResponse?.ok)
      alignmentResponse = await fetch('/api/alignment', { method: 'POST' });
    let alignmentResult =
      (await alignmentResponse.json()) as Partial<AlignmentResult> & {
        readonly error?: { readonly message?: string };
      };
    if (
      !alignmentResponse.ok ||
      !alignmentResult.sourceSpace ||
      !alignmentResult.targetSpace
    )
      throw new Error(
        alignmentResult.error?.message ??
          'The pages could not be aligned by the image-processing server.',
      );
    if (alignment?.method === 'manual' && alignmentResult.method !== 'manual') {
      alignmentResponse = await fetch('/api/alignment/manual', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scale: alignment.scale,
          rotation: alignment.rotation,
          translationX: alignment.translation.x,
          translationY: alignment.translation.y,
        }),
      });
      alignmentResult =
        (await alignmentResponse.json()) as typeof alignmentResult;
      if (
        !alignmentResponse.ok ||
        !alignmentResult.sourceSpace ||
        !alignmentResult.targetSpace
      )
        throw new Error(
          alignmentResult.error?.message ??
            'The saved manual page alignment could not be reconnected.',
        );
    }
    setAlignment(alignmentResult as AlignmentResult);
  }

  async function restoreProject(project: ProjectSnapshot) {
    setAudioSessionRevision((revision) => revision + 1);
    const nextUrls: Partial<Record<SourceImageRole, string>> = {};
    const nextBlobs: Partial<Record<SourceImageRole, Blob>> = {};
    let nextOriginal: SourceImageMetadata | null = null;
    let nextCleaned: SourceImageMetadata | null = null;
    let nextAudioFile: File | null = null;
    let nextAudioSource: typeof audioSource = null;
    for (const reference of project.assets) {
      const content = await projectService.getAsset(reference.hash);
      if (!content)
        throw new Error(`Project asset ${reference.filename} is missing.`);
      if (reference.role === 'audio') {
        nextAudioSource = { metadata: reference.metadata, blob: content };
        nextAudioFile = new File([content], reference.filename, {
          type: reference.mediaType,
        });
      } else {
        const metadata = reference.metadata as unknown as SourceImageMetadata;
        nextUrls[reference.role] = URL.createObjectURL(content);
        nextBlobs[reference.role] = content;
        if (reference.role === 'original') nextOriginal = metadata;
        else nextCleaned = metadata;
      }
    }
    Object.values(urlRef.current).forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    setSourceUrls(nextUrls);
    setSourceBlobs(nextBlobs);
    setPair({
      original: nextOriginal,
      cleaned: nextCleaned,
      dimensionsMatch:
        nextOriginal && nextCleaned
          ? nextOriginal.dimensions.width === nextCleaned.dimensions.width &&
            nextOriginal.dimensions.height === nextCleaned.dimensions.height
          : null,
    });
    ocrAbortRef.current?.abort();
    ocrRequestIdRef.current += 1;
    setOcrStatus(null);
    setAlignment(project.alignment as AlignmentResult | null);
    setTextRegions(project.textRegions as readonly TextRegion[]);
    const fallbackImage = nextOriginal ?? nextCleaned;
    const storedEditor =
      (project.editor as EditorDocument | null) ??
      (fallbackImage
        ? {
            imageSpace: createImageSpace(
              `workspace:${fallbackImage.id}`,
              fallbackImage.dimensions.width,
              fallbackImage.dimensions.height,
            ),
            bubbles: {},
            observations: {},
            dialogues: {},
            order: [],
          }
        : null);
    setEditorDocument(storedEditor);
    setLoadedEditorDocument(storedEditor);
    setSavedTranscript(project.transcript as Transcript | null);
    setAudioSource(nextAudioSource);
    setLoadedAudioFile(nextAudioFile);
    setAlignmentImages((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous.overlay);
        URL.revokeObjectURL(previous.difference);
      }
      return null;
    });
    setTextDebugUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setActiveProject(project);
    setProjectMessage(`Opened “${project.name}”.`);
    setSavedProjects(await projectService.list());
  }

  async function collectProjectData(project: ProjectSnapshot) {
    const assets = new Map(project.assets.map((asset) => [asset.role, asset]));
    const assetBytes: Array<{ hash: string; blob: Blob; mediaType: string }> =
      [];
    for (const role of ['original', 'cleaned'] as const) {
      const metadata = pair[role];
      const blob = sourceBlobs[role];
      if (!metadata || !blob) continue;
      const hash = await hashBlob(blob);
      assets.set(role, {
        hash,
        role,
        filename: metadata.filename,
        mediaType: metadata.mediaType,
        sizeBytes: blob.size,
        metadata: metadata as unknown as Record<string, unknown>,
      });
      assetBytes.push({ hash, blob, mediaType: metadata.mediaType });
    }
    if (audioSource) {
      const hash = await hashBlob(audioSource.blob);
      const metadata = audioSource.metadata;
      assets.set('audio', {
        hash,
        role: 'audio',
        filename: String(metadata.filename ?? 'audio'),
        mediaType: String(metadata.mediaType ?? audioSource.blob.type),
        sizeBytes: audioSource.blob.size,
        metadata,
      });
      assetBytes.push({
        hash,
        blob: audioSource.blob,
        mediaType: String(metadata.mediaType ?? audioSource.blob.type),
      });
    }
    const editor = editorDocumentRef.current;
    const dialogues = editor ? Object.values(editor.dialogues) : [];
    const snapshot: ProjectSnapshot = {
      ...project,
      assets: [...assets.values()],
      alignment,
      bubbles: editor ? Object.values(editor.bubbles) : project.bubbles,
      textRegions,
      ocr: editor ? Object.values(editor.observations) : project.ocr,
      transcript: savedTranscript,
      mappings: project.mappings,
      captionLayouts: project.captionLayouts,
      timeline: dialogues,
      styles: {
        dialogues: Object.fromEntries(
          dialogues.map((dialogue) => [
            dialogue.id,
            {
              fontFamily: dialogue.fontFamily,
              fontSizePx: dialogue.fontSizePx,
              lineSpacingPx: dialogue.lineSpacingPx,
              paddingPx: dialogue.paddingPx,
              position: dialogue.position,
            },
          ]),
        ),
      },
      renderSettings: project.renderSettings,
      editor,
    };
    return { snapshot, assetBytes };
  }

  async function saveProject() {
    try {
      const basis = activeProject ?? projectService.newProject();
      const { snapshot, assetBytes } = await collectProjectData(basis);
      const saved = await projectService.save(snapshot, assetBytes);
      setActiveProject(saved);
      setSavedProjects(await projectService.list());
      setProjectMessage(`Saved “${saved.name}”.`);
    } catch (cause) {
      setProjectMessage(
        cause instanceof Error ? cause.message : 'Project could not be saved.',
      );
    }
  }

  async function saveProjectAs(name: string) {
    try {
      const basis = activeProject ?? projectService.newProject(name);
      const { snapshot, assetBytes } = await collectProjectData(basis);
      const saved = await projectService.saveAs(snapshot, name, assetBytes);
      setActiveProject(saved);
      setSavedProjects(await projectService.list());
      setProjectMessage(`Saved copy as “${saved.name}”.`);
    } catch (cause) {
      setProjectMessage(
        cause instanceof Error ? cause.message : 'Save As failed.',
      );
    }
  }

  async function duplicateProject() {
    if (!activeProject) return;
    try {
      const { snapshot, assetBytes } = await collectProjectData(activeProject);
      const saved = await projectService.save(snapshot, assetBytes);
      const copy = await projectService.duplicate(saved.id);
      await restoreProject(copy);
    } catch (cause) {
      setProjectMessage(
        cause instanceof Error
          ? cause.message
          : 'Project could not be duplicated.',
      );
    }
  }

  async function importProjectFile(file?: File) {
    if (!file) return;
    try {
      const archive = JSON.parse(await file.text()) as unknown;
      await restoreProject(await projectService.importArchive(archive));
    } catch (cause) {
      setProjectMessage(
        cause instanceof Error
          ? cause.message
          : 'Project archive could not be imported.',
      );
    }
  }

  async function exportProject() {
    if (!activeProject) {
      setProjectMessage('Save the project before exporting it.');
      return;
    }
    try {
      const { snapshot } = await collectProjectData(activeProject);
      const archive = await projectService.exportArchive(snapshot);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(archive)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${snapshot.name.replace(/[^a-z0-9-_]+/gi, '-')}.comic-captioner.json`;
      link.click();
      URL.revokeObjectURL(url);
      setProjectMessage(`Exported “${snapshot.name}”.`);
    } catch (cause) {
      setProjectMessage(
        cause instanceof Error
          ? cause.message
          : 'Project archive could not be exported.',
      );
    }
  }

  async function exportFrame(format: 'png' | 'jpeg') {
    const source = sourceBlobs.original;
    const document = editorDocumentRef.current;
    if (!source || !document) {
      setProjectMessage(
        'Import the original comic and create the editor page before exporting.',
      );
      return;
    }
    const enteredTime = window.prompt(
      'Export frame at audio time (seconds)',
      '0',
    );
    if (enteredTime === null) return;
    const time = Number(enteredTime);
    const layouts = (activeProject?.captionLayouts ??
      []) as readonly CaptionLayout[];
    const bubbles: ExportBubble[] = Object.values(document.bubbles).map(
      (bubble) => ({
        id: bubble.id as ExportBubble['id'],
        polygon: bubble.polygon,
      }),
    );
    const captions: ExportCaption[] = document.order.map((id) => {
      const dialogue = document.dialogues[id]!;
      const mapping = activeProject?.mappings.find((value) => {
        if (!value || typeof value !== 'object') return false;
        const candidate = value as { transcriptSegmentId?: string };
        return candidate.transcriptSegmentId === id;
      }) as { confidence?: number; bubbleId?: string | null } | undefined;
      return {
        id,
        bubbleId: dialogue.bubbleId,
        caption: dialogue.caption,
        layout:
          layouts.find(
            (layout) =>
              layout.bubbleId === dialogue.bubbleId &&
              layout.text === dialogue.caption,
          ) ?? null,
        start: dialogue.start,
        end: dialogue.end,
        mapped:
          Boolean(document.bubbles[dialogue.bubbleId]) &&
          (mapping?.bubbleId === undefined ||
            mapping.bubbleId === dialogue.bubbleId),
        // A manually selected target has no calibrated confidence in the
        // current editor model. Leave it unknown for export validation.
        mappingConfidence: mapping?.confidence ?? null,
        confidence: mapping?.confidence ?? null,
      };
    });
    try {
      const { blob, report } = await exportComicFrame(
        source,
        captions,
        bubbles,
        time,
        format,
      );
      if (!blob) {
        const details = report.issues
          .map(
            (issue) => `${issue.captionId}: ${issue.code} — ${issue.message}`,
          )
          .join('\n');
        setProjectMessage(
          `Export validation found ${report.issues.length} issue(s):\n${details}`,
        );
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${(activeProject?.name ?? 'comic').replace(/[^a-z0-9-_]+/gi, '-')}-${time}s.${format}`;
      link.click();
      URL.revokeObjectURL(url);
      setProjectMessage(`Exported ${format.toUpperCase()} frame at ${time}s.`);
    } catch (cause) {
      setProjectMessage(
        cause instanceof Error ? cause.message : 'Frame export failed.',
      );
    }
  }

  function exportTimelineData() {
    const document = editorDocumentRef.current;
    if (!document) return { captions: [], bubbles: [] };
    const layouts = (activeProject?.captionLayouts ??
      []) as readonly CaptionLayout[];
    const bubbles: ExportBubble[] = Object.values(document.bubbles).map(
      (bubble) => ({
        id: bubble.id as ExportBubble['id'],
        polygon: bubble.polygon,
      }),
    );
    const captions: ExportCaption[] = document.order.map((id) => {
      const dialogue = document.dialogues[id]!;
      const mapping = activeProject?.mappings.find((value) => {
        if (!value || typeof value !== 'object') return false;
        return (
          (value as { transcriptSegmentId?: string }).transcriptSegmentId === id
        );
      }) as { confidence?: number; bubbleId?: string | null } | undefined;
      return {
        id,
        bubbleId: dialogue.bubbleId,
        caption: dialogue.caption,
        layout:
          layouts.find(
            (layout) =>
              layout.bubbleId === dialogue.bubbleId &&
              layout.text === dialogue.caption,
          ) ?? null,
        start: dialogue.start,
        end: dialogue.end,
        mapped:
          Boolean(document.bubbles[dialogue.bubbleId]) &&
          (mapping?.bubbleId === undefined ||
            mapping.bubbleId === dialogue.bubbleId),
        mappingConfidence: mapping?.confidence ?? null,
        confidence: mapping?.confidence ?? null,
      };
    });
    return { captions, bubbles };
  }

  async function exportVideo() {
    // Original-only export: auto-inpaint so captions sit on clean art.
    if (needsAutoClean(pair)) {
      const cleanedReady = await ensureCleanedPage();
      if (!cleanedReady) {
        setProjectMessage(
          'Auto-clean failed. Import a cleaned page or retry auto-clean before export.',
        );
        return;
      }
    }
    const pageBlob = sourceBlobs.cleaned ?? sourceBlobs.original;
    if (!pageBlob || !audioSource?.blob) {
      setProjectMessage(
        'MP4 export needs a comic page (original or cleaned) and audio.',
      );
      return;
    }
    const controller = new AbortController();
    mp4AbortRef.current = controller;
    setMp4Exporting(true);
    setMp4Progress({ percent: 0, currentTime: 0, duration: 0 });
    try {
      const { captions, bubbles } = exportTimelineData();
      // Prefer server-side deterministic FFmpeg encode; falls back to browser
      // captureStream when FFmpeg is missing or the API is unreachable.
      const blob = await exportMp4ViaServer(
        pageBlob,
        audioSource.blob,
        captions,
        bubbles,
        mp4Resolution === 'custom'
          ? {
              resolution: 'custom',
              width: Number(customVideoWidth),
              height: Number(customVideoHeight),
            }
          : { resolution: mp4Resolution },
        controller.signal,
        setMp4Progress,
      );
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${(activeProject?.name ?? 'comic').replace(/[^a-z0-9-_]+/gi, '-')}.mp4`;
      link.click();
      URL.revokeObjectURL(url);
      setProjectMessage('MP4 export completed.');
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError'))
        setProjectMessage(
          cause instanceof Error ? cause.message : 'MP4 export failed.',
        );
      else setProjectMessage('MP4 export cancelled.');
    } finally {
      mp4AbortRef.current = null;
      setMp4Exporting(false);
    }
  }

  function createNewProject() {
    const name = window.prompt('New project name', 'Untitled comic');
    if (!name?.trim()) return;
    Object.values(urlRef.current).forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    if (alignmentImagesRef.current) {
      URL.revokeObjectURL(alignmentImagesRef.current.overlay);
      URL.revokeObjectURL(alignmentImagesRef.current.difference);
    }
    if (textDebugUrlRef.current) URL.revokeObjectURL(textDebugUrlRef.current);
    setPair(emptyPair);
    ocrAbortRef.current?.abort();
    ocrRequestIdRef.current += 1;
    setOcrStatus(null);
    setSourceUrls({});
    setSourceBlobs({});
    setAlignment(null);
    setAlignmentImages(null);
    setTextRegions([]);
    setEditorDocument(null);
    setLoadedEditorDocument(null);
    setSavedTranscript(null);
    setSpeechProposals(null);
    setSpeechAutomationWarning(null);
    setAudioSource(null);
    setLoadedAudioFile(null);
    setAudioSessionRevision((revision) => revision + 1);
    setActiveProject(projectService.newProject(name.trim()));
    setProjectMessage(`Created “${name.trim()}”.`);
  }

  const original = imageLayer('original', pair.original, sourceUrls.original);
  const cleaned = imageLayer('cleaned', pair.cleaned, sourceUrls.cleaned);
  const reviewDialogues = editorDocument
    ? editorDocument.order
        .map((id) => editorDocument.dialogues[id])
        .filter((dialogue): dialogue is NonNullable<typeof dialogue> =>
          Boolean(dialogue),
        )
    : [];
  const activeNarration = reviewDialogues.find(
    (dialogue) =>
      dialogue.caption.trim() &&
      dialogue.start <= audioClock.positionSeconds &&
      audioClock.positionSeconds < dialogue.end,
  );
  const reviewLayouts = (activeProject?.captionLayouts ??
    []) as readonly CaptionLayout[];
  const automaticMappings = useMemo(
    () =>
      proposeTranscriptBubbleMappings(
        editorDocument,
        savedTranscript,
        readingOrder,
      ),
    [editorDocument, savedTranscript, readingOrder],
  );
  const reviewMappings =
    speechProposals?.map((proposal) => proposal.mapping) ?? automaticMappings;
  const activeTranscriptMapping = savedTranscript
    ? reviewMappings.find((mapping) => {
        const segment = savedTranscript.segments.find(
          (item) => item.id === mapping.transcriptSegmentId,
        );
        return Boolean(
          segment &&
          segment.interval.start.value <= audioClock.positionSeconds &&
          audioClock.positionSeconds < segment.interval.end.value,
        );
      })
    : undefined;
  const activeTranscriptSegment =
    activeTranscriptMapping && savedTranscript
      ? savedTranscript.segments.find(
          (item) => item.id === activeTranscriptMapping.transcriptSegmentId,
        )
      : undefined;
  const activeChosenBubbleId = activeTranscriptMapping
    ? (mappingChoices[activeTranscriptMapping.id] ??
      activeTranscriptMapping.bubbleId)
    : null;
  const mappedTranscriptLayout =
    activeChosenBubbleId && activeTranscriptSegment
      ? reviewLayouts.find(
          (layout) =>
            layout.bubbleId === activeChosenBubbleId &&
            layout.text === activeTranscriptSegment.text,
        )
      : undefined;
  const activeSpeechProposal = speechProposals?.find(
    (proposal) => proposal.mapping.id === activeTranscriptMapping?.id,
  );
  const activeProposedFit = activeSpeechProposal?.candidateLayouts.find(
    (candidate) => candidate.bubbleId === activeChosenBubbleId,
  );
  const proposedTranscriptLayout =
    activeSpeechProposal &&
    !dismissedMappingIds.includes(activeSpeechProposal.mapping.id)
      ? (activeProposedFit?.layout ??
        (activeSpeechProposal.layout?.bubbleId === activeChosenBubbleId
          ? activeSpeechProposal.layout
          : undefined))
      : undefined;
  const activeReviewLayout =
    proposedTranscriptLayout ??
    mappedTranscriptLayout ??
    (activeNarration
      ? reviewLayouts.find(
          (layout) =>
            layout.bubbleId === activeNarration.bubbleId &&
            layout.text === activeNarration.caption,
        )
      : undefined);
  const activeReviewText =
    (proposedTranscriptLayout || mappedTranscriptLayout) &&
    activeTranscriptSegment
      ? activeTranscriptSegment.text
      : activeNarration?.caption;

  function approveLiveMapping(mapping: DialogueMapping) {
    if (!savedTranscript) return;
    const segment = savedTranscript.segments.find(
      (item) => item.id === mapping.transcriptSegmentId,
    );
    const bubbleId = mappingChoices[mapping.id] ?? mapping.bubbleId;
    if (!segment || !bubbleId) return;
    setMappingCommand((previous) => ({
      revision: (previous?.revision ?? 0) + 1,
      transcriptSegmentId: segment.id,
      bubbleId,
      caption: segment.text,
      start: segment.interval.start.value,
      end: segment.interval.end.value,
    }));
    const automated = speechProposals?.find(
      (proposal) => proposal.mapping.id === mapping.id,
    );
    const fittedLayout =
      automated?.candidateLayouts.find(
        (candidate) => candidate.bubbleId === bubbleId,
      )?.layout ??
      (automated?.layout?.bubbleId === bubbleId ? automated.layout : null);
    if (fittedLayout) {
      const project = activeProject ?? projectService.newProject();
      setActiveProject({
        ...project,
        captionLayouts: [
          ...(project.captionLayouts as readonly CaptionLayout[]).filter(
            (layout) => layout.bubbleId !== bubbleId,
          ),
          fittedLayout,
        ],
      });
    }
    setDismissedMappingIds((ids) =>
      ids.includes(mapping.id) ? ids : [...ids, mapping.id],
    );
  }

  return (
    <main className="comic-app-shell min-h-screen bg-stone-100 text-stone-900">
      <div className="comic-app-content mx-auto max-w-7xl">
        <header className="comic-topbar mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div className="comic-brand-block">
            <div className="comic-mark" aria-hidden="true">
              CC
            </div>
            <div>
              <p className="comic-brand-name">Comic Captioner</p>
              <h1 className="comic-project-name">
                {activeProject?.name ?? 'Untitled motion comic'}
              </h1>
              <p className="comic-project-status">
                <span className="comic-status-dot" />
                {activeProject ? 'Saved locally' : 'Unsaved project'}
              </p>
            </div>
          </div>
          <div
            className="comic-header-actions flex flex-wrap items-center gap-2"
            id="export-actions"
          >
            <button
              className="editor-button"
              onClick={createNewProject}
              type="button"
            >
              New
            </button>
            <select
              aria-label="Open saved project"
              className="editor-input max-w-48"
              value=""
              onChange={(event) => {
                const id = event.currentTarget.value;
                if (id)
                  void projectService
                    .open(id)
                    .then(restoreProject)
                    .catch((cause: unknown) =>
                      setProjectMessage(
                        cause instanceof Error
                          ? cause.message
                          : 'Could not open project.',
                      ),
                    );
              }}
            >
              <option value="">Open…</option>
              {savedProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button
              className="editor-button"
              onClick={() => void saveProject()}
              type="button"
            >
              Save
            </button>
            <button
              className="editor-button"
              onClick={() => {
                const name = window.prompt(
                  'Save project as',
                  `${activeProject?.name ?? 'Comic'} copy`,
                );
                if (name) void saveProjectAs(name);
              }}
              type="button"
            >
              Save As
            </button>
            <button
              className="editor-button"
              disabled={!activeProject?.revision}
              onClick={() => void duplicateProject()}
              type="button"
            >
              Duplicate
            </button>
            <button
              className="editor-button"
              onClick={() => projectImportRef.current?.click()}
              type="button"
            >
              Import
            </button>
            <input
              ref={projectImportRef}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                void importProjectFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <button
              className="editor-button"
              disabled={!activeProject}
              onClick={() => void exportProject()}
              type="button"
            >
              Export
            </button>
            <button
              className="editor-button"
              disabled={!pair.original || !editorDocument}
              onClick={() => void exportFrame('png')}
              type="button"
            >
              PNG frame
            </button>
            <button
              className="editor-button"
              disabled={!pair.original || !editorDocument}
              onClick={() => void exportFrame('jpeg')}
              type="button"
            >
              JPEG frame
            </button>
            <select
              aria-label="MP4 export resolution"
              className="editor-input"
              disabled={mp4Exporting}
              value={mp4Resolution}
              onChange={(event) =>
                setMp4Resolution(event.currentTarget.value as Mp4Resolution)
              }
            >
              <option value="720p">MP4 · 720p</option>
              <option value="1080p">MP4 · 1080p</option>
              <option value="custom">MP4 · Custom</option>
            </select>
            {mp4Resolution === 'custom' && (
              <span className="flex items-center gap-1">
                <input
                  aria-label="Custom video width"
                  className="editor-input w-20"
                  type="number"
                  min="16"
                  max="7680"
                  step="2"
                  value={customVideoWidth}
                  onChange={(event) =>
                    setCustomVideoWidth(event.currentTarget.value)
                  }
                />
                <span>×</span>
                <input
                  aria-label="Custom video height"
                  className="editor-input w-20"
                  type="number"
                  min="16"
                  max="7680"
                  step="2"
                  value={customVideoHeight}
                  onChange={(event) =>
                    setCustomVideoHeight(event.currentTarget.value)
                  }
                />
              </span>
            )}
            {!mp4Exporting ? (
              <button
                className="editor-button"
                disabled={
                  (!pair.original && !pair.cleaned) ||
                  !audioSource?.blob ||
                  !editorDocument ||
                  autoCleanBusy
                }
                onClick={() => void exportVideo()}
                type="button"
              >
                Export MP4
              </button>
            ) : (
              <button
                className="editor-button"
                onClick={() => mp4AbortRef.current?.abort()}
                type="button"
              >
                Cancel export
              </button>
            )}
            {mp4Progress && (
              <div
                className="flex min-w-48 items-center gap-2"
                aria-live="polite"
              >
                <progress
                  aria-label="MP4 export progress"
                  className="w-28"
                  max="100"
                  value={mp4Progress.percent}
                />
                <span className="text-xs tabular-nums">
                  {Math.floor(mp4Progress.percent)}% ·{' '}
                  {mp4Progress.currentTime.toFixed(1)}s /{' '}
                  {mp4Progress.duration.toFixed(1)}s
                </span>
              </div>
            )}
          </div>
          <div className="comic-import-toolbar flex flex-wrap gap-3">
            <ImageUploadControl
              busy={busyRole === 'original'}
              label="Original comic"
              onSelect={(file) => void importImage('original', file)}
            />
            <button
              className="rounded-xl border border-indigo-200 bg-white px-4 py-3 text-sm font-semibold text-indigo-800 shadow-sm transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!pair.original || !pair.cleaned || alignmentBusy}
              onClick={() => void runAlignment()}
              type="button"
            >
              {alignmentBusy ? 'Aligning…' : 'Align pages'}
            </button>
            <button
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900 shadow-sm hover:bg-emerald-100 disabled:opacity-50"
              disabled={(!pair.original && !pair.cleaned) || pageAnalysisBusy}
              onClick={() => void analyzePage()}
              type="button"
            >
              {pageAnalysisBusy ? 'Scanning bubbles…' : 'Detect bubbles'}
            </button>
            <button
              className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-900 shadow-sm hover:bg-sky-100 disabled:opacity-50"
              disabled={
                (!pair.original && !pair.cleaned) ||
                ocrStatus?.phase === 'preparing' ||
                ocrStatus?.phase === 'loading-models' ||
                ocrStatus?.phase === 'recognizing'
              }
              onClick={() => void extractText()}
              type="button"
            >
              {ocrStatus?.phase === 'preparing' ||
              ocrStatus?.phase === 'loading-models' ||
              ocrStatus?.phase === 'recognizing'
                ? 'Extracting text…'
                : ocrStatus?.phase === 'error'
                  ? 'Retry local OCR'
                  : 'Extract text · local OCR'}
            </button>
            <button
              className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-900 shadow-sm hover:bg-indigo-100 disabled:opacity-50"
              disabled={
                (!pair.original && !pair.cleaned) ||
                pageAnalysisBusy ||
                ocrStatus?.phase === 'preparing' ||
                ocrStatus?.phase === 'loading-models' ||
                ocrStatus?.phase === 'recognizing'
              }
              onClick={() => void scanAndExtract()}
              type="button"
            >
              Scan + extract
            </button>
            <button
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950 shadow-sm hover:bg-amber-100 disabled:opacity-50"
              disabled={
                (!pair.original && !pair.cleaned) ||
                ocrStatus?.phase === 'preparing' ||
                ocrStatus?.phase === 'loading-models' ||
                ocrStatus?.phase === 'recognizing'
              }
              onClick={() => void retryEnhancedOCR()}
              type="button"
            >
              Retry with enhanced preprocessing
            </button>
            <ImageUploadControl
              busy={busyRole === 'cleaned'}
              label="Cleaned comic (optional)"
              onSelect={(file) => void importImage('cleaned', file)}
            />
            <button
              className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-semibold text-violet-900 shadow-sm hover:bg-violet-100 disabled:opacity-50"
              disabled={!pair.original || autoCleanBusy || busyRole !== null}
              onClick={() => void autoCleanFromOriginal()}
              type="button"
              title="Erase bubble text from the original page automatically. Import a hand-prepared cleaned page anytime to override. Runs automatically when you import an original page."
            >
              {autoCleanBusy ? 'Auto-cleaning…' : 'Auto-clean page'}
            </button>
            <label className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-3 text-sm font-medium text-stone-800 shadow-sm">
              Reading order
              <select
                className="rounded border border-stone-300 px-2 py-1 text-sm"
                value={readingDirection}
                onChange={(event) => {
                  setReadingDirection(
                    event.target.value === 'rtl' ? 'rtl' : 'ltr',
                  );
                }}
              >
                <option value="ltr">LTR</option>
                <option value="rtl">RTL (manga)</option>
              </select>
            </label>
            <label
              className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-3 text-sm font-medium text-stone-800 shadow-sm"
              title="ML proposes bubble candidates to boost recall; deterministic geometry always refines and scores the final contour."
            >
              Bubble proposals
              <select
                className="rounded border border-stone-300 px-2 py-1 text-sm"
                value={bubbleProposalSource}
                onChange={(event) => {
                  setBubbleProposalSource(
                    event.target.value === 'ml' ? 'ml' : 'heuristic',
                  );
                }}
              >
                <option value="heuristic">Heuristic</option>
                <option value="ml">ML (YOLO)</option>
              </select>
            </label>
          </div>
          {ocrStatus && (
            <div
              className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900"
              role="status"
              aria-live="polite"
            >
              {ocrStatus.message}
              {ocrStatus.phase === 'ready' && ocrMetrics && (
                <span className="ml-2 text-xs">
                  {ocrMetrics.detectedTextRegions} text regions ·{' '}
                  {Math.round(ocrMetrics.initializationMs)} ms model init ·{' '}
                  {Math.round(ocrMetrics.detectionMs)} ms detection ·{' '}
                  {Math.round(ocrMetrics.recognitionMs)} ms recognition ·{' '}
                  {Math.round(ocrMetrics.averageConfidence * 100)}% mean
                  confidence
                </span>
              )}
            </div>
          )}
          {ocrReviewItems.length > 0 && (
            <div
              className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
              aria-label="OCR confidence review queue"
            >
              <div className="font-semibold">
                OCR review queue · {ocrReviewItems.length} uncertain item(s)
              </div>
              <div className="mt-1 max-h-28 space-y-1 overflow-y-auto">
                {ocrReviewItems.map((item) => (
                  <div className="flex items-start gap-2 text-xs" key={item.id}>
                    <span className="tabular-nums font-semibold">
                      {Math.round(item.confidence * 100)}%
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{item.text || '(empty)'}</span>
                      <span className="block text-amber-800">{item.reason}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </header>

        {projectMessage && (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700">
            <span>
              {projectMessage}
              {activeProject
                ? ` · ${activeProject.name} · rev ${activeProject.revision}`
                : ''}
            </span>
            <button
              aria-label="Dismiss project message"
              onClick={() => setProjectMessage(null)}
            >
              ×
            </button>
          </div>
        )}

        {error && (
          <p
            className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            role="alert"
          >
            {error}
          </p>
        )}

        {original || cleaned ? (
          <div className="comic-shell-body">
            <ToolSidebar />
            <div className="comic-workspace-column">
              <EditingWorkspace
                original={
                  original
                    ? { metadata: original.metadata, src: original.src }
                    : null
                }
                cleaned={
                  cleaned
                    ? { metadata: cleaned.metadata, src: cleaned.src }
                    : null
                }
                initialDocument={loadedEditorDocument}
                analysis={pageAnalysis}
                transcript={savedTranscript}
                mappingCommand={mappingCommand}
                audioName={
                  typeof audioSource?.metadata.filename === 'string'
                    ? audioSource.metadata.filename
                    : null
                }
                audioAsset={
                  audioSource
                    ? {
                        format: String(audioSource.metadata.format ?? 'audio'),
                        durationSeconds: Number(
                          audioSource.metadata.durationSeconds ??
                            audioClock.durationSeconds,
                        ),
                        sizeBytes: Number(
                          audioSource.metadata.sizeBytes ??
                            audioSource.blob.size,
                        ),
                      }
                    : null
                }
                audioClock={audioClock}
                hasTranscript={Boolean(savedTranscript)}
                liveTranscriptText={activeTranscriptSegment?.text ?? ''}
                onAudioToggle={() => {
                  void audioControlsRef.current?.toggle();
                }}
                onAudioSeek={(timeSeconds) =>
                  audioControlsRef.current?.seek(timeSeconds)
                }
                onAudioImport={() => audioControlsRef.current?.import()}
                onAutomateSpeech={() => void automateSpeech()}
                speechAutomationBusy={speechAutomationBusy}
                speechAutomationReady={Boolean(
                  original && cleaned && alignment && audioSource,
                )}
                readingOrder={readingOrder}
                onDocumentChange={(value) => {
                  editorDocumentRef.current = value;
                  setEditorDocument(value);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <OriginalViewer image={original} />
            <CleanedViewer image={cleaned} />
          </div>
        )}
        <details className="mt-5 rounded-xl border border-stone-200 bg-white p-4">
          <summary className="cursor-pointer font-medium">
            Compare source images
          </summary>
          <div className="mt-4">
            <ComparisonViewer
              cleaned={cleaned}
              dimensionsMatch={pair.dimensionsMatch}
              onOpacityChange={setOpacity}
              opacity={opacity}
              original={original}
            />
          </div>
        </details>
        <div id="audio-panel" className="comic-secondary-panel">
          <AudioWorkspace
            key={audioSessionRevision}
            initialAudioFile={loadedAudioFile}
            initialTranscript={savedTranscript}
            onTranscriptChange={(transcript) => {
              setSavedTranscript(transcript);
              setSpeechProposals(null);
              setSpeechAutomationWarning(null);
            }}
            onClockChange={setAudioClock}
            seekRequest={seekRequest}
            onAudioControls={(controls) => {
              audioControlsRef.current = controls;
            }}
            onAudioAsset={(asset) =>
              setAudioSource({
                metadata: asset.metadata as unknown as Record<string, unknown>,
                blob: asset.blob,
              })
            }
          />
        </div>
        <section
          id="narration-review"
          aria-label="Live narration review"
          className="comic-secondary-panel mt-5 rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm"
        >
          {speechAutomationWarning && (
            <p
              className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              role="status"
            >
              {speechAutomationWarning} Bubble detection and shape fitting still
              ran; review and select bubble matches manually.
            </p>
          )}
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Live narration review</h2>
              <p className="text-sm text-stone-600">
                Review captions at their audio time. Captions render in their
                assigned bubbles using saved fitted layouts.
              </p>
            </div>
            <div className="font-mono text-sm tabular-nums" aria-live="polite">
              {audioClock.positionSeconds.toFixed(2)}s
            </div>
          </div>
          {activeTranscriptMapping && activeTranscriptSegment && (
            <div className="my-4 grid gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-800">
                  Transcript at audio time · proposed bubble{' '}
                  {activeTranscriptMapping.bubbleId ?? 'needs review'}
                </div>
                <p className="mt-1 text-lg">{activeTranscriptSegment.text}</p>
                <p className="mt-1 text-xs text-indigo-900">
                  {activeTranscriptSegment.interval.start.value.toFixed(2)}–
                  {activeTranscriptSegment.interval.end.value.toFixed(2)}s ·{' '}
                  {Math.round(activeTranscriptMapping.confidence * 100)}% match
                  confidence ·{' '}
                  {activeTranscriptMapping.reviewFlag.replaceAll('-', ' ')}
                </p>
                <p className="mt-1 text-xs text-stone-600">
                  {activeTranscriptMapping.reasons
                    .map((reason) => reason.evidence)
                    .join(' · ')}
                </p>
              </div>
              {!dismissedMappingIds.includes(activeTranscriptMapping.id) && (
                <button
                  className="rounded-md bg-indigo-700 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                  disabled={
                    !activeChosenBubbleId ||
                    Boolean(activeSpeechProposal && !activeProposedFit?.layout)
                  }
                  onClick={() => approveLiveMapping(activeTranscriptMapping)}
                  type="button"
                >
                  Approve match + timing
                </button>
              )}
            </div>
          )}
          {reviewMappings.some(
            (mapping) => !dismissedMappingIds.includes(mapping.id),
          ) && (
            <details
              className="mb-4 rounded-lg border border-stone-200 p-3"
              open={Boolean(
                activeTranscriptMapping &&
                !dismissedMappingIds.includes(activeTranscriptMapping.id),
              )}
            >
              <summary className="cursor-pointer text-sm font-semibold">
                Automatic transcript matches ·{' '}
                {
                  reviewMappings.filter(
                    (mapping) => !dismissedMappingIds.includes(mapping.id),
                  ).length
                }{' '}
                to review
              </summary>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {reviewMappings
                  .filter(
                    (mapping) => !dismissedMappingIds.includes(mapping.id),
                  )
                  .map((mapping) => {
                    const segment = savedTranscript?.segments.find(
                      (item) => item.id === mapping.transcriptSegmentId,
                    );
                    if (!segment) return null;
                    const chosenBubbleId =
                      mappingChoices[mapping.id] ?? mapping.bubbleId ?? '';
                    const fittedProposal = speechProposals?.find(
                      (item) => item.mapping.id === mapping.id,
                    );
                    const selectedFit = fittedProposal?.candidateLayouts.find(
                      (candidate) => candidate.bubbleId === chosenBubbleId,
                    );
                    const selectedLayoutIsValid =
                      !fittedProposal ||
                      Boolean(
                        selectedFit?.layout ||
                        fittedProposal.layout?.bubbleId === chosenBubbleId,
                      );
                    return (
                      <article
                        className="rounded-lg border border-stone-200 bg-white p-3"
                        key={mapping.id}
                      >
                        <p className="text-sm font-medium">{segment.text}</p>
                        <p className="mt-1 text-xs text-stone-500">
                          {segment.interval.start.value.toFixed(2)}–
                          {segment.interval.end.value.toFixed(2)}s ·{' '}
                          {Math.round(mapping.confidence * 100)}% ·{' '}
                          {mapping.reviewFlag.replaceAll('-', ' ')}
                        </p>
                        {fittedProposal && !selectedLayoutIsValid && (
                          <p className="mt-1 text-xs text-amber-800">
                            Select a bubble to preview its caption fit.{' '}
                            {selectedFit?.fitError ?? fittedProposal.fitError}
                          </p>
                        )}
                        {selectedLayoutIsValid && fittedProposal && (
                          <p className="mt-1 text-xs text-emerald-700">
                            Caption fitted to this bubble’s safe region.
                          </p>
                        )}
                        <label className="mt-2 block text-xs">
                          Bubble
                          <select
                            className="editor-input ml-2"
                            value={chosenBubbleId}
                            onChange={(event) =>
                              setMappingChoices((choices) => ({
                                ...choices,
                                [mapping.id]: event.currentTarget.value,
                              }))
                            }
                          >
                            <option value="">No confident match</option>
                            {mapping.alternatives.map((candidate) => (
                              <option
                                key={candidate.bubbleId}
                                value={candidate.bubbleId}
                              >
                                {candidate.bubbleId} ·{' '}
                                {Math.round(candidate.confidence * 100)}%
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="mt-2 flex gap-2">
                          <button
                            className="rounded border border-indigo-300 px-2 py-1 text-xs text-indigo-800 hover:bg-indigo-50"
                            onClick={() =>
                              setSeekRequest((previous) => ({
                                time: segment.interval.start.value,
                                revision: (previous?.revision ?? 0) + 1,
                              }))
                            }
                            type="button"
                          >
                            Preview at {segment.interval.start.value.toFixed(1)}
                            s
                          </button>
                          <button
                            className="rounded bg-indigo-700 px-2 py-1 text-xs font-semibold text-white disabled:opacity-40"
                            disabled={!chosenBubbleId || !selectedLayoutIsValid}
                            onClick={() =>
                              approveLiveMapping({
                                ...mapping,
                                bubbleId:
                                  chosenBubbleId as typeof mapping.bubbleId,
                              })
                            }
                            type="button"
                          >
                            Approve text + timing
                          </button>
                          <button
                            className="rounded border border-stone-300 px-2 py-1 text-xs"
                            onClick={() =>
                              setDismissedMappingIds((ids) => [
                                ...ids,
                                mapping.id,
                              ])
                            }
                            type="button"
                          >
                            Dismiss
                          </button>
                        </div>
                      </article>
                    );
                  })}
              </div>
            </details>
          )}
          {cleaned &&
          activeReviewLayout &&
          (activeNarration ||
            (activeTranscriptMapping?.bubbleId && activeTranscriptSegment)) ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <LayeredComicRenderer
                className="mx-auto w-full max-w-3xl overflow-hidden rounded-lg border border-stone-200"
                src={cleaned.src}
                width={cleaned.metadata.dimensions.width}
                height={cleaned.metadata.dimensions.height}
                layouts={[activeReviewLayout]}
                motionTimeSeconds={audioClock.positionSeconds}
                motionStartSeconds={
                  activeTranscriptSegment?.interval.start.value ??
                  activeNarration?.start
                }
                motionEndSeconds={
                  activeTranscriptSegment?.interval.end.value ??
                  activeNarration?.end
                }
              />
              <div className="rounded-lg bg-indigo-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                  {activeSpeechProposal &&
                  !dismissedMappingIds.includes(activeSpeechProposal.mapping.id)
                    ? `Caption proposal · ${Math.round(activeSpeechProposal.mapping.confidence * 100)}% match confidence`
                    : 'Now narrating'}
                </div>
                <p className="mt-2 text-lg">{activeReviewText}</p>
                <p className="mt-3 text-sm text-stone-600">
                  {activeTranscriptSegment && activeTranscriptMapping?.bubbleId
                    ? `${activeTranscriptSegment.interval.start.value.toFixed(2)}s – ${activeTranscriptSegment.interval.end.value.toFixed(2)}s · Proposed match ${Math.round(activeTranscriptMapping.confidence * 100)}%`
                    : `${activeNarration!.start.toFixed(2)}s – ${activeNarration!.end.toFixed(2)}s · ${activeNarration!.fontFamily}`}{' '}
                  {activeReviewLayout.fontSizePx}px
                </p>
              </div>
            </div>
          ) : cleaned ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-600">
              {activeTranscriptSegment &&
              activeTranscriptMapping?.bubbleId &&
              !mappedTranscriptLayout
                ? `The transcript is matched to bubble ${activeTranscriptMapping.bubbleId} at this audio time, but no saved fitted layout exists for this exact transcript text yet.`
                : activeTranscriptSegment && !activeTranscriptMapping?.bubbleId
                  ? 'A transcript segment is active, but the automatic mapper found no confident bubble match. Review its alternatives below.'
                  : activeNarration
                    ? 'This narration event has no saved fitted layout yet. Fit and save its caption layout to review it here.'
                    : reviewDialogues.length
                      ? 'No caption is active at this audio time. Use the event list below to jump to a narration.'
                      : 'Add dialogue events and fitted caption layouts to start narration review.'}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-600">
              Import a cleaned comic page to review narration in context.
            </p>
          )}
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-semibold">Narration events</h3>
            {reviewDialogues.length ? (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {reviewDialogues.map((dialogue) => {
                  const isActive = dialogue.id === activeNarration?.id;
                  const hasLayout = reviewLayouts.some(
                    (layout) =>
                      layout.bubbleId === dialogue.bubbleId &&
                      layout.text === dialogue.caption,
                  );
                  return (
                    <button
                      className={`min-w-52 rounded-lg border p-3 text-left text-sm ${isActive ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300' : 'border-stone-200 bg-white hover:bg-stone-50'}`}
                      key={dialogue.id}
                      onClick={() =>
                        setSeekRequest((previous) => ({
                          time: dialogue.start,
                          revision: (previous?.revision ?? 0) + 1,
                        }))
                      }
                      type="button"
                    >
                      <span className="block font-medium">
                        {dialogue.caption || 'Untitled dialogue'}
                      </span>
                      <span className="mt-1 block text-xs text-stone-500">
                        {dialogue.start.toFixed(2)}–{dialogue.end.toFixed(2)}s ·{' '}
                        {hasLayout ? 'fitted' : 'layout needed'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-stone-500">No dialogue events yet.</p>
            )}
          </div>
        </section>
        {alignment && alignmentImages && original && (
          <AlignmentReview
            alignment={alignment}
            image={{ ...original, src: alignmentImages[alignmentMode] }}
            mode={alignmentMode}
            onModeChange={setAlignmentMode}
            onSave={saveManualAlignment}
          />
        )}
        {alignment && original && (
          <TextDifferenceReview
            debugUrl={textDebugUrl}
            image={original}
            onDetect={() => void detectRemovedText()}
            regions={textRegions}
            running={textDetectionBusy}
          />
        )}
        <p className="mt-6 text-center text-xs text-stone-500">
          Saved projects and their binary assets are stored locally in this
          browser. Export a project archive to move it to another browser or
          device.
        </p>
      </div>
    </main>
  );
}

function ToolSidebar() {
  const [active, setActive] = useState('Media');
  const tools = [
    { label: 'Media', target: 'comic-assets', glyph: '▧' },
    { label: 'Comics', target: 'comic-preview', glyph: '▣' },
    { label: 'Captions', target: 'comic-timeline', glyph: 'T' },
    { label: 'Audio', target: 'audio-panel', glyph: '♫' },
    { label: 'Text', target: 'text-tools', glyph: '≡' },
    { label: 'Export', target: 'export-actions', glyph: '⇧' },
  ];
  return (
    <nav className="tool-sidebar" aria-label="Editor sections">
      <div className="tool-sidebar-label">Workspace</div>
      {tools.map((tool) => (
        <button
          key={tool.label}
          type="button"
          className={`tool-nav-item ${active === tool.label ? 'is-active' : ''}`}
          aria-current={active === tool.label ? 'page' : undefined}
          title={`Show ${tool.label}`}
          onClick={() => {
            setActive(tool.label);
            document.getElementById(tool.target)?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          }}
        >
          <span className="tool-nav-glyph" aria-hidden="true">
            {tool.glyph}
          </span>
          <span>{tool.label}</span>
        </button>
      ))}
    </nav>
  );
}

function TextDifferenceReview({
  debugUrl,
  image,
  onDetect,
  regions,
  running,
}: {
  readonly debugUrl: string | null;
  readonly image: ImageLayer;
  readonly onDetect: () => void;
  readonly regions: readonly TextRegion[];
  readonly running: boolean;
}) {
  return (
    <section
      id="text-tools"
      className="comic-secondary-panel mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">
            Removed-text candidates
          </h2>
          <p className="mt-1 text-sm text-stone-600">
            Directional pixel changes grouped by text-like shape. Review these
            regions; they are not bubble detections.
          </p>
        </div>
        <button
          className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
          disabled={running}
          onClick={onDetect}
          type="button"
        >
          {running ? 'Finding text…' : 'Find removed text'}
        </button>
      </div>
      {debugUrl && (
        <ImageCanvas
          layers={[{ ...image, src: debugUrl }]}
          title="Difference debug · red marks text candidates, blue marks other changes"
          toolbar
        />
      )}
      {debugUrl && (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {regions.map((region, index) => (
            <li
              className="rounded-lg border border-stone-200 px-3 py-2 text-sm"
              key={region.id}
            >
              <span className="font-medium text-stone-800">
                Region {index + 1}
              </span>
              <span className="ml-2 text-stone-500">
                {Math.round(region.confidence * 100)}% confidence
              </span>
              <span className="mt-1 block text-xs text-stone-500">
                x {Math.round(region.boundingBox.x)}, y{' '}
                {Math.round(region.boundingBox.y)},{' '}
                {Math.round(region.boundingBox.width)} ×{' '}
                {Math.round(region.boundingBox.height)} image px
              </span>
            </li>
          ))}
          {regions.length === 0 && (
            <li className="text-sm text-stone-500">
              No likely removed text was found.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function AlignmentReview({
  alignment,
  image,
  mode,
  onModeChange,
  onSave,
}: {
  readonly alignment: AlignmentResult;
  readonly image: ImageLayer;
  readonly mode: 'overlay' | 'difference';
  readonly onModeChange: (mode: 'overlay' | 'difference') => void;
  readonly onSave: (parameters: {
    readonly scale: number;
    readonly rotation: number;
    readonly translationX: number;
    readonly translationY: number;
  }) => Promise<void>;
}) {
  const [scale, setScale] = useState(String(alignment.scale));
  const [rotationDegrees, setRotationDegrees] = useState(
    String((alignment.rotation * 180) / Math.PI),
  );
  const [translationX, setTranslationX] = useState(
    String(alignment.translation.x),
  );
  const [translationY, setTranslationY] = useState(
    String(alignment.translation.y),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setScale(String(alignment.scale));
    setRotationDegrees(String((alignment.rotation * 180) / Math.PI));
    setTranslationX(String(alignment.translation.x));
    setTranslationY(String(alignment.translation.y));
  }, [alignment]);

  async function saveCorrection() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        scale: Number(scale),
        rotation: (Number(rotationDegrees) * Math.PI) / 180,
        translationX: Number(translationX),
        translationY: Number(translationY),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The correction could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">
            Alignment review
          </h2>
          <p className="mt-1 text-sm text-stone-600">
            {alignment.method === 'manual'
              ? 'Manual correction'
              : 'Automatic estimate'}{' '}
            · confidence {Math.round(alignment.confidence * 100)}%
          </p>
        </div>
        <div className="flex gap-2">
          {(['overlay', 'difference'] as const).map((value) => (
            <button
              aria-pressed={mode === value}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === value ? 'bg-indigo-700 text-white' : 'bg-stone-100 text-stone-700'}`}
              key={value}
              onClick={() => onModeChange(value)}
              type="button"
            >
              {value === 'overlay' ? 'Overlay' : 'Difference'}
            </button>
          ))}
        </div>
      </div>
      <ImageCanvas
        layers={[image]}
        title={
          mode === 'overlay' ? 'Aligned overlay' : 'Aligned pixel difference'
        }
        toolbar
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AlignmentNumber
          label="Scale"
          value={scale}
          onChange={setScale}
          step="0.001"
        />
        <AlignmentNumber
          label="Rotation (degrees)"
          value={rotationDegrees}
          onChange={setRotationDegrees}
          step="0.1"
        />
        <AlignmentNumber
          label="Horizontal translation (image px)"
          value={translationX}
          onChange={setTranslationX}
          step="0.5"
        />
        <AlignmentNumber
          label="Vertical translation (image px)"
          value={translationY}
          onChange={setTranslationY}
          step="0.5"
        />
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <button
        className="mt-4 rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
        disabled={
          saving ||
          ![scale, rotationDegrees, translationX, translationY].every((value) =>
            Number.isFinite(Number(value)),
          )
        }
        onClick={() => void saveCorrection()}
        type="button"
      >
        {saving ? 'Applying…' : 'Apply manual correction'}
      </button>
      <p className="mt-3 break-all text-xs text-stone-500">
        Cleaned → original matrix: [
        {alignment.transformMatrix.values
          .map((value) => value.toFixed(4))
          .join(', ')}
        ]
      </p>
    </section>
  );
}

function AlignmentNumber({
  label,
  value,
  onChange,
  step,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly step: string;
}) {
  return (
    <label className="text-xs font-medium text-stone-600">
      {label}
      <input
        className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900"
        onChange={(event) => onChange(event.currentTarget.value)}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

function ImageUploadControl({
  label,
  busy,
  onSelect,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly onSelect: (file?: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className="rounded-xl bg-indigo-700 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-800 disabled:cursor-wait disabled:opacity-60"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        {busy ? 'Importing…' : `Add ${label.toLowerCase()}`}
      </button>
      <input
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        className="sr-only"
        onChange={(event) => {
          onSelect(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
        ref={inputRef}
        type="file"
      />
    </>
  );
}

function imageLayer(
  role: SourceImageRole,
  metadata: SourceImageMetadata | null,
  src?: string,
): ImageLayer | null {
  return metadata && src ? { role, metadata, src } : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
