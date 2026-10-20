import { useEffect, useMemo, useRef, useState } from 'react';
import './editor-shell.css';
import {
  EditorInspector,
  type InspectorSelection,
} from './EditorInspector.js';
import { EditorTimeline } from './EditorTimeline.js';
import {
  IconAudio,
  IconBubble,
  IconImage,
  IconLayers,
  IconOcr,
  IconPages,
  IconRedo,
  IconSave,
  IconText,
  IconTheme,
  IconUndo,
  IconUpload,
  IconVideo,
  IconZoomIn,
  IconZoomOut,
} from './editor-icons.js';
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
import { LetteringCleanupReview } from './LetteringCleanupReview.js';
import {
  cleanPageViaApi,
  removalMaskToOverlayPng,
  type CleanPageApiResult,
} from './clean-page-client.js';
import type {
  ExportBubble,
  ExportCaption,
} from '../../../packages/rendering/src/validation.js';
import { exportComicFrame } from './browser-export.js';
import { exportMp4ViaServer } from './mp4-export.js';
import type { Mp4ExportProgress, Mp4Resolution } from './mp4-export.js';
import { VideoExportPanel } from './VideoExportPanel.js';
import {
  ToolDrawer,
  ToolDrawerRow,
  ToolDrawerSection,
} from './ToolDrawer.js';
import {
  buildMultiPageExportPlan,
  createPageWorkspace,
  movePage,
  replacePage,
  type PageWorkspace,
} from './project-pages.js';
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
  const [playbackLoop, setPlaybackLoop] = useState(false);
  const [canvasBackdrop, setCanvasBackdrop] = useState(true);
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
    readonly words?: readonly {
      readonly text: string;
      readonly start: number;
      readonly end: number;
    }[];
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
  const [projectPages, setProjectPages] = useState<readonly PageWorkspace[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [editorTheme, setEditorTheme] = useState<'light' | 'dark'>('light');
  const [activeTool, setActiveTool] = useState('pages');
  const [canvasZoom, setCanvasZoom] = useState(100);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(280);
  const [timelineZoom, setTimelineZoom] = useState(40);
  const [timelineSelection, setTimelineSelection] = useState<{
    kind: 'page' | 'audio' | 'caption';
    id: string;
  } | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [editorHistoryStatus, setEditorHistoryStatus] = useState({
    canUndo: false,
    canRedo: false,
    undoDepth: 0,
    redoDepth: 0,
    undoPreview: [] as string[],
    redoPreview: [] as string[],
  });
  const [liveSelection, setLiveSelection] = useState<{
    kind: 'none' | 'bubble' | 'caption';
    bubbleId: string | null;
    dialogueId: string | null;
    bubble: {
      id: string;
      kind: string;
      confidence: number | null;
      boundingBox: { x: number; y: number; width: number; height: number };
    } | null;
    caption: {
      id: string;
      text: string;
      startSeconds: number;
      endSeconds: number;
      fontFamily: string;
      fontSizePx: number;
      words?: readonly { text: string; start: number; end: number }[];
    } | null;
  } | null>(null);

  useEffect(() => {
    const onHistory = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          canUndo: boolean;
          canRedo: boolean;
          undoDepth: number;
          redoDepth: number;
          undoPreview?: string[];
          redoPreview?: string[];
        }>
      ).detail;
      if (detail)
        setEditorHistoryStatus({
          canUndo: detail.canUndo,
          canRedo: detail.canRedo,
          undoDepth: detail.undoDepth,
          redoDepth: detail.redoDepth,
          undoPreview: detail.undoPreview ?? [],
          redoPreview: detail.redoPreview ?? [],
        });
    };
    const onSelection = (event: Event) => {
      const detail = (event as CustomEvent<typeof liveSelection>).detail;
      if (detail) setLiveSelection(detail);
    };
    window.addEventListener('comic-editor-history', onHistory);
    window.addEventListener('comic-editor-selection', onSelection);
    return () => {
      window.removeEventListener('comic-editor-history', onHistory);
      window.removeEventListener('comic-editor-selection', onSelection);
    };
  }, []);

  const canUndo = editorHistoryStatus.canUndo;
  const canRedo = editorHistoryStatus.canRedo;

  useEffect(() => {
    document.documentElement.dataset.theme = editorTheme;
  }, [editorTheme]);

  // Loop narration when playback reaches the end.
  useEffect(() => {
    if (!playbackLoop) return;
    if (audioClock.status !== 'playing') return;
    const duration =
      audioClock.durationSeconds ||
      Number(audioSource?.metadata.durationSeconds ?? 0);
    if (duration <= 0) return;
    if (audioClock.positionSeconds < duration - 0.05) return;
    setSeekRequest((previous) => ({
      time: 0,
      revision: (previous?.revision ?? 0) + 1,
    }));
  }, [
    playbackLoop,
    audioClock.status,
    audioClock.positionSeconds,
    audioClock.durationSeconds,
    audioSource,
  ]);
  const projectImportRef = useRef<HTMLInputElement>(null);
  const pageImportInputRef = useRef<HTMLInputElement>(null);
  const [pair, setPair] = useState<ImagePair>(emptyPair);
  const [sourceUrls, setSourceUrls] = useState<
    Partial<Record<SourceImageRole, string>>
  >({});
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
      readonly geometryProvenance?: 'model' | 'derived' | 'hybrid';
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
    readonly textRegions?: readonly {
      readonly id: string;
      readonly boundingBox: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly confidence: number;
      readonly associatedBubbleId?: string | null;
      readonly associationConfidence?: number;
      readonly associationClassification?: 'dialogue' | 'non-dialogue' | 'ambiguous';
      readonly needsReview?: boolean;
      readonly kindHint?: string;
    }[];
    readonly confidences?: {
      readonly bubbleDetection: number;
      readonly textRegionDetection: number;
      readonly ocrRecognition: number | null;
      readonly bubbleAssociation: number | null;
    };
    readonly panels?: readonly {
      readonly id: string;
      readonly bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly label?: string;
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
  const [letteringResult, setLetteringResult] =
    useState<CleanPageApiResult | null>(null);
  const [letteringMaskUrl, setLetteringMaskUrl] = useState<string | null>(null);
  const [showRemovalMask, setShowRemovalMask] = useState(false);
  const [letteringAccepted, setLetteringAccepted] = useState(false);
  const [letteringManualAdds, setLetteringManualAdds] = useState<Uint8Array[]>(
    [],
  );
  const [letteringManualExcludes, setLetteringManualExcludes] = useState<
    Uint8Array[]
  >([]);
  const [letteringMaskEdit, setLetteringMaskEdit] = useState<
    'idle' | 'add' | 'exclude'
  >('idle');
  const [letteringApprovedIds, setLetteringApprovedIds] = useState<string[]>(
    [],
  );
  const letteringStrokeRef = useRef<{
    mode: 'add' | 'exclude';
    layer: Uint8Array;
  } | null>(null);
  const letteringRequestRef = useRef(0);
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
      // Production lettering-removal pass via the API for method records,
      // warnings, and manual-mask editing. Original bytes stay intact.
      void runLetteringRemoval({
        imageBytes: new Uint8Array(
          raster.data.buffer,
          raster.data.byteOffset,
          raster.data.byteLength,
        ),
        width: raster.width,
        height: raster.height,
      });
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

  /** Call `/api/clean-page` and store comparison + method records. */
  async function runLetteringRemoval(input: {
    imageBytes: Uint8Array;
    width: number;
    height: number;
    regionIds?: readonly string[];
    approvedRegionIds?: readonly string[];
    erasureScope?: 'bubble-interior' | 'approved';
    manualAdds?: readonly Uint8Array[];
    manualExcludes?: readonly Uint8Array[];
  }) {
    const requestId = `lettering-${++letteringRequestRef.current}`;
    try {
      const pixelCount = input.width * input.height;
      const manualEdits: {
        regionId?: string;
        addPixels?: Uint8Array;
        excludePixels?: Uint8Array;
      }[] = [];
      const adds = input.manualAdds ?? letteringManualAdds;
      const excludes = input.manualExcludes ?? letteringManualExcludes;
      if (adds.length > 0) {
        const add = new Uint8Array(pixelCount);
        for (const layer of adds) {
          if (layer.length !== pixelCount) continue;
          for (let i = 0; i < pixelCount; i += 1) if (layer[i]) add[i] = 1;
        }
        manualEdits.push({ addPixels: add });
      }
      if (excludes.length > 0) {
        const exclude = new Uint8Array(pixelCount);
        for (const layer of excludes) {
          if (layer.length !== pixelCount) continue;
          for (let i = 0; i < pixelCount; i += 1) if (layer[i]) exclude[i] = 1;
        }
        manualEdits.push({ excludePixels: exclude });
      }
      const approvedSet = new Set(input.approvedRegionIds ?? []);
      const textRegions = (pageAnalysis?.textRegions ?? [])
        .filter(
          (region) =>
            !input.regionIds || input.regionIds.includes(region.id),
        )
        .map((region) => {
          const approved = approvedSet.has(region.id);
          return {
            id: region.id,
            boundingBox: [
              region.boundingBox.x,
              region.boundingBox.y,
              region.boundingBox.width,
              region.boundingBox.height,
            ] as [number, number, number, number],
            ...(region.confidence !== undefined
              ? { detectionConfidence: region.confidence }
              : {}),
            ...(region.associatedBubbleId !== undefined
              ? { associatedBubbleId: region.associatedBubbleId }
              : {}),
            ...(approved
              ? { approved: true, reviewStatus: 'accepted' as const }
              : {}),
          };
        });
      const bubbles = (pageAnalysis?.bubbles ?? []).map((bubble) => ({
        id: bubble.id,
        contour: bubble.polygon.points.map((point) => ({
          x: point.x,
          y: point.y,
        })),
        interiorHint: 'white-balloon' as const,
      }));
      const result = await cleanPageViaApi({
        imageBytes: input.imageBytes,
        width: input.width,
        height: input.height,
        requestId,
        textRegions,
        bubbles,
        manualEdits,
        // Default safety: only bubble-interior lettering auto-erases.
        erasureScope: input.erasureScope ?? 'bubble-interior',
      });
      if (result.status === 'stale' || letteringRequestRef.current !== Number(requestId.split('-').pop())) {
        return;
      }
      setLetteringResult(result);
      setLetteringAccepted(false);
      if (result.removalMask.length === input.width * input.height) {
        const blob = removalMaskToOverlayPng(
          result.removalMask,
          input.width,
          input.height,
        );
        setLetteringMaskUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(blob);
        });
      }
    } catch {
      // Lettering API is an enhancement; local auto-clean result remains.
    }
  }

  async function reprocessLettering(options?: {
    readonly regionIds?: readonly string[];
    readonly approvedRegionIds?: readonly string[];
    readonly erasureScope?: 'bubble-interior' | 'approved';
    readonly manualAdds?: readonly Uint8Array[];
    readonly manualExcludes?: readonly Uint8Array[];
    readonly resetApproved?: boolean;
  }) {
    const file = sourceBlobs.original;
    const metadata = pair.original;
    if (!file || !metadata) return;
    const raster = await rasterFromImageSource(file);
    if (options?.resetApproved) setLetteringApprovedIds([]);
    await runLetteringRemoval({
      imageBytes: new Uint8Array(
        raster.data.buffer,
        raster.data.byteOffset,
        raster.data.byteLength,
      ),
      width: raster.width,
      height: raster.height,
      ...(options?.regionIds ? { regionIds: options.regionIds } : {}),
      ...(options?.approvedRegionIds
        ? { approvedRegionIds: options.approvedRegionIds }
        : options?.resetApproved
          ? { approvedRegionIds: [] }
          : { approvedRegionIds: letteringApprovedIds }),
      ...(options?.erasureScope
        ? { erasureScope: options.erasureScope }
        : {}),
      ...(options?.manualAdds ? { manualAdds: options.manualAdds } : {}),
      ...(options?.manualExcludes
        ? { manualExcludes: options.manualExcludes }
        : {}),
    });
  }

  function paintLetteringMask(
    mode: 'add' | 'exclude',
    x: number,
    y: number,
    radius: number,
  ) {
    const metadata = pair.original;
    if (!metadata) return;
    const width = metadata.dimensions.width;
    const height = metadata.dimensions.height;
    let stroke = letteringStrokeRef.current;
    if (!stroke || stroke.mode !== mode) {
      stroke = { mode, layer: new Uint8Array(width * height) };
      letteringStrokeRef.current = stroke;
      if (mode === 'add') {
        setLetteringManualAdds((previous) => [...previous, stroke!.layer]);
      } else {
        setLetteringManualExcludes((previous) => [...previous, stroke!.layer]);
      }
    }
    const layer = stroke.layer;
    const r = Math.max(1, Math.round(radius));
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r2) continue;
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        layer[py * width + px] = 1;
      }
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
    let panels: readonly {
      id: string;
      bounds: { x: number; y: number; width: number; height: number };
      label?: string;
    }[] = [];
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
        panels = panelOrder.panels.map((panel) => ({
          id: panel.id,
          bounds: {
            x: panel.bounds.x,
            y: panel.bounds.y,
            width: panel.bounds.width,
            height: panel.bounds.height,
          },
          label: panel.id,
        }));
      } catch {
        // Hybrid/panel analysis is an enhancement; keep server bubbles if it fails.
      }
    }

    setPageAnalysis((previous) => ({
      bubbles,
      ...(previous?.textRegions ? { textRegions: previous.textRegions } : {}),
      ...(previous?.confidences ? { confidences: previous.confidences } : {}),
      ...(panels.length > 0
        ? { panels }
        : previous?.panels
          ? { panels: previous.panels }
          : {}),
      ocr: previous?.ocr ?? result.ocr,
    }));
    setProjectMessage(
      order
        ? `Bubble scan found ${bubbles.length} candidates (reading order: ${order.length} panels/bubbles, ${readingDirection.toUpperCase()}). Review regions on the comic canvas.`
        : `Bubble scan found ${bubbles.length} candidates. Review and select regions on the comic canvas.`,
    );
    // Independent text-region detection + association (best-effort).
    void refreshPageTextRegions();
    return { ...result, bubbles };
  }

  /** Call `/api/detect-page` and merge text regions + separate confidences. */
  async function refreshPageTextRegions() {
    try {
      const role = sourceBlobs.original && pair.original ? 'original' : 'cleaned';
      const image = sourceBlobs[role];
      const metadata = pair[role];
      if (!image || !metadata) return;
      const bytes = new Uint8Array(await image.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const response = await fetch('/api/detect-page', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageImage: btoa(binary),
          width: metadata.dimensions.width,
          height: metadata.dimensions.height,
          includeOcr: false,
          requestId: `web-${metadata.id}-${Date.now()}`,
        }),
      });
      const result = (await response.json()) as {
        readonly status?: string;
        readonly textRegions?: readonly {
          readonly id: string;
          readonly boundingBox: {
            readonly x: number;
            readonly y: number;
            readonly width: number;
            readonly height: number;
          };
          readonly confidence: number;
          readonly associatedBubbleId?: string | null;
          readonly associationConfidence?: number;
          readonly associationClassification?: 'dialogue' | 'non-dialogue' | 'ambiguous';
          readonly needsReview?: boolean;
          readonly kindHint?: string;
        }[];
        readonly confidences?: {
          readonly bubbleDetection: number;
          readonly textRegionDetection: number;
          readonly ocrRecognition: number | null;
          readonly bubbleAssociation: number | null;
        };
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || result.status === 'stale') {
        if (result.error?.message) {
          setProjectMessage(result.error.message);
        }
        return;
      }
      setPageAnalysis((previous) =>
        previous
          ? {
              ...previous,
              textRegions: result.textRegions ?? [],
              ...(result.confidences
                ? { confidences: result.confidences }
                : {}),
            }
          : previous,
      );
    } catch {
      // Text-region analysis is an enhancement; never block bubble editing.
    }
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
    setPageAnalysis((previous) => ({
      bubbles: previous?.bubbles ?? [],
      ...(previous?.textRegions ? { textRegions: previous.textRegions } : {}),
      ...(previous?.confidences ? { confidences: previous.confidences } : {}),
      ocr,
    }));
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
      setPageAnalysis({
        bubbles: result.bubbles,
        ocr: result.ocr,
      });
      void refreshPageTextRegions();
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
        words: dialogueExportWords(dialogue, id),
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

  function dialogueExportWords(
    dialogue: { readonly words?: readonly { text: string; start: number; end: number }[] },
    dialogueId: string,
  ) {
    if (dialogue.words && dialogue.words.length > 0) {
      return dialogue.words.map((word) => ({
        text: word.text,
        start: word.start,
        end: word.end,
      }));
    }
    const segment = savedTranscript?.segments.find(
      (item) => item.id === dialogueId,
    );
    return segment?.words.map((word) => ({
      text: word.text,
      start: word.start.value,
      end: word.end.value,
    }));
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
        words: dialogueExportWords(dialogue, id),
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
    setProjectPages([]);
    setActivePageId(null);
  }

  function captureActivePage(): PageWorkspace | null {
    const id = activePageId;
    if (!id) return null;
    const existing = projectPages.find((page) => page.id === id);
    return {
      id,
      label: existing?.label ?? 'Page',
      original: pair.original,
      cleaned: pair.cleaned,
      originalBlob: sourceBlobs.original ?? null,
      cleanedBlob: sourceBlobs.cleaned ?? null,
      editor: editorDocument,
      panels: pageAnalysis?.panels ?? existing?.panels ?? [],
      ...(existing?.pacingOverride
        ? { pacingOverride: existing.pacingOverride }
        : {}),
    };
  }

  async function flushActivePage(): Promise<void> {
    const captured = captureActivePage();
    if (!captured) return;
    setProjectPages((pages) => replacePage(pages, captured));
  }

  async function activatePage(pageId: string) {
    if (pageId === activePageId) return;
    await flushActivePage();
    const target = projectPages.find((page) => page.id === pageId);
    if (!target) return;
    // Load target into the single-page workspace.
    const nextUrls: Partial<Record<SourceImageRole, string>> = {};
    const nextBlobs: Partial<Record<SourceImageRole, Blob>> = {};
    if (target.originalBlob && target.original) {
      nextUrls.original = URL.createObjectURL(target.originalBlob);
      nextBlobs.original = target.originalBlob;
    }
    if (target.cleanedBlob && target.cleaned) {
      nextUrls.cleaned = URL.createObjectURL(target.cleanedBlob);
      nextBlobs.cleaned = target.cleanedBlob;
    }
    Object.values(urlRef.current).forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    setSourceUrls(nextUrls);
    setSourceBlobs(nextBlobs);
    setPair({
      original: target.original,
      cleaned: target.cleaned,
      dimensionsMatch:
        target.original && target.cleaned
          ? target.original.dimensions.width ===
              target.cleaned.dimensions.width &&
            target.original.dimensions.height ===
              target.cleaned.dimensions.height
          : null,
    });
    setEditorDocument(target.editor);
    setLoadedEditorDocument(target.editor);
    setPageAnalysis(
      target.panels.length > 0
        ? {
            bubbles: target.editor
              ? Object.values(target.editor.bubbles).map((bubble) => ({
                  id: bubble.id,
                  kind: bubble.kind,
                  confidence: bubble.confidence ?? 1,
                  polygon: bubble.polygon,
                  tail: bubble.tail
                    ? bubble.tail.points.map((point) => ({
                        x: point.x,
                        y: point.y,
                      }))
                    : null,
                }))
              : [],
            panels: target.panels,
            ocr: { blocks: [] },
          }
        : null,
    );
    setActivePageId(target.id);
    setProjectMessage(`Editing “${target.label}”.`);
  }

  async function addEmptyPage() {
    await flushActivePage();
    const page = createPageWorkspace(
      `Page ${projectPages.length + 1}`,
    );
    setProjectPages((pages) => [...pages, page]);
    setActivePageId(page.id);
    Object.values(urlRef.current).forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    setSourceUrls({});
    setSourceBlobs({});
    setPair(emptyPair);
    setEditorDocument(null);
    setLoadedEditorDocument(null);
    setPageAnalysis(null);
    setProjectMessage(`Added “${page.label}”. Import its comic image.`);
  }

  async function importPageFiles(files: readonly File[]) {
    await flushActivePage();
    const created: PageWorkspace[] = [];
    for (const [index, file] of files.entries()) {
      const mediaType = (
        file.type === 'image/jpeg' || file.type === 'image/webp'
          ? file.type
          : 'image/png'
      ) as SourceImageMetadata['mediaType'];
      const format: SourceImageMetadata['format'] =
        mediaType === 'image/jpeg'
          ? 'JPEG'
          : mediaType === 'image/webp'
            ? 'WEBP'
            : 'PNG';
      const metadata: SourceImageMetadata = {
        id: crypto.randomUUID(),
        role: 'original',
        filename: file.name,
        format,
        mediaType,
        sha256: '',
        sizeBytes: file.size,
        dimensions: { width: 0, height: 0 },
      };
      // Dimensions filled after decode; store blob now so export can use it.
      const bitmap = await createImageBitmap(file).catch(() => null);
      const sized: SourceImageMetadata = bitmap
        ? {
            ...metadata,
            dimensions: { width: bitmap.width, height: bitmap.height },
          }
        : metadata;
      bitmap?.close();
      created.push({
        ...createPageWorkspace(
          files.length === 1
            ? file.name.replace(/\.[^.]+$/, '')
            : `Page ${projectPages.length + index + 1}`,
        ),
        original: sized,
        originalBlob: file,
      });
    }
    setProjectPages((pages) => [...pages, ...created]);
    if (created[0]) {
      setActivePageId(created[0].id);
      await activatePageFrom(created[0], created);
      setProjectMessage(
        `Imported ${created.length} page(s). Active: “${created[0].label}”.`,
      );
    }
  }

  async function activatePageFrom(
    target: PageWorkspace,
    registry: readonly PageWorkspace[],
  ) {
    const nextUrls: Partial<Record<SourceImageRole, string>> = {};
    const nextBlobs: Partial<Record<SourceImageRole, Blob>> = {};
    if (target.originalBlob && target.original) {
      nextUrls.original = URL.createObjectURL(target.originalBlob);
      nextBlobs.original = target.originalBlob;
    }
    if (target.cleanedBlob && target.cleaned) {
      nextUrls.cleaned = URL.createObjectURL(target.cleanedBlob);
      nextBlobs.cleaned = target.cleanedBlob;
    }
    Object.values(urlRef.current).forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    setSourceUrls(nextUrls);
    setSourceBlobs(nextBlobs);
    setPair({
      original: target.original,
      cleaned: target.cleaned,
      dimensionsMatch:
        target.original && target.cleaned
          ? target.original.dimensions.width ===
              target.cleaned.dimensions.width &&
            target.original.dimensions.height ===
              target.cleaned.dimensions.height
          : null,
    });
    setEditorDocument(target.editor);
    setLoadedEditorDocument(target.editor);
    setActivePageId(target.id);
    void registry;
  }

  const multiPagePlan = useMemo(() => {
    const pages = [...projectPages];
    const active = captureActivePage();
    if (active) {
      const index = pages.findIndex((page) => page.id === active.id);
      if (index >= 0) pages[index] = active;
      else pages.push(active);
    }
    const dialoguesByPageId: Record<
      string,
      { id: string; bubbleId: string; caption: string; start: number; end: number }[]
    > = {};
    for (const page of pages) {
      if (!page.editor) continue;
      dialoguesByPageId[page.id] = Object.values(page.editor.dialogues).map(
        (dialogue) => ({
          id: dialogue.id,
          bubbleId: dialogue.bubbleId,
          caption: dialogue.caption,
          start: dialogue.start,
          end: dialogue.end,
        }),
      );
    }
    return buildMultiPageExportPlan({
      pages,
      durationSeconds: Number(audioSource?.metadata.durationSeconds ?? 0) || 0,
      dialoguesByPageId,
    });
    // captureActivePage reads live workspace state via closure; recompute when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectPages,
    pair,
    sourceBlobs,
    editorDocument,
    activePageId,
    audioSource,
    pageAnalysis,
  ]);

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
  const pagesForTimeline = useMemo(() => {
    const order = [...projectPages];
    const active = captureActivePage();
    if (active) {
      const index = order.findIndex((page) => page.id === active.id);
      if (index >= 0) order[index] = active;
      else order.push(active);
    }
    const duration = Number(audioSource?.metadata.durationSeconds ?? 0) || 0;
    const slice =
      order.length > 0 && duration > 0
        ? duration / order.length
        : Math.max(1, duration);
    return order.map((page, index) => {
      const image = page.cleanedBlob ?? page.originalBlob;
      const meta = page.cleaned ?? page.original;
      return {
        id: page.id,
        label: page.label,
        width: meta?.dimensions.width ?? 0,
        height: meta?.dimensions.height ?? 0,
        startSeconds: index * slice,
        endSeconds:
          index === order.length - 1 ? duration || (index + 1) * slice : (index + 1) * slice,
        thumbnailUrl: image ? URL.createObjectURL(image) : null,
        selected: page.id === activePageId,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPages, pair, sourceBlobs, activePageId, audioSource]);

  const inspectorSelection: InspectorSelection = useMemo(() => {
    if (liveSelection?.kind === 'bubble' && liveSelection.bubble) {
      return {
        kind: 'bubble',
        id: liveSelection.bubble.id,
        label: `Bubble ${liveSelection.bubble.kind}`,
        ...(liveSelection.bubble.confidence != null
          ? { confidence: liveSelection.bubble.confidence }
          : {}),
        classification: liveSelection.bubble.kind,
        captionText: liveSelection.caption?.text ?? '',
        ...(liveSelection.caption?.fontFamily
          ? { fontFamily: liveSelection.caption.fontFamily }
          : {}),
        ...(liveSelection.caption?.fontSizePx != null
          ? { fontSizePx: liveSelection.caption.fontSizePx }
          : {}),
        bounds: liveSelection.bubble.boundingBox,
        onCaptionTextChange: (value) => {
          const id = liveSelection.caption?.id ?? liveSelection.dialogueId;
          if (!id) return;
          window.dispatchEvent(
            new CustomEvent('comic-editor-caption-text', {
              detail: { id, text: value },
            }),
          );
        },
        onFontSizeChange: (value) => {
          const id = liveSelection.caption?.id ?? liveSelection.dialogueId;
          if (!id) return;
          window.dispatchEvent(
            new CustomEvent('comic-editor-caption-font', {
              detail: { id, fontSizePx: value },
            }),
          );
        },
        onBoundsChange: (bounds) =>
          window.dispatchEvent(
            new CustomEvent('comic-editor-bubble-geometry', {
              detail: { id: liveSelection.bubble!.id, ...bounds },
            }),
          ),
        onClassificationChange: (kind) =>
          window.dispatchEvent(
            new CustomEvent('comic-editor-bubble-geometry', {
              detail: { id: liveSelection.bubble!.id, kind },
            }),
          ),
      };
    }
    if (liveSelection?.kind === 'caption' && liveSelection.caption) {
      const caption = liveSelection.caption;
      return {
        kind: 'caption',
        id: caption.id,
        text: caption.text,
        startSeconds: caption.startSeconds,
        endSeconds: caption.endSeconds,
        fontFamily: caption.fontFamily,
        fontSizePx: caption.fontSizePx,
        ...(caption.words ? { words: caption.words } : {}),
        estimated: !caption.words?.length,
        onTextChange: (value) =>
          window.dispatchEvent(
            new CustomEvent('comic-editor-caption-text', {
              detail: { id: caption.id, text: value },
            }),
          ),
        onTimeChange: (start, end) =>
          window.dispatchEvent(
            new CustomEvent('comic-editor-caption-time', {
              detail: { id: caption.id, start, end },
            }),
          ),
        onFontSizeChange: (value) =>
          window.dispatchEvent(
            new CustomEvent('comic-editor-caption-font', {
              detail: { id: caption.id, fontSizePx: value },
            }),
          ),
        onWordsChange: (words) =>
          window.dispatchEvent(
            new CustomEvent('comic-editor-caption-words', {
              detail: { id: caption.id, words },
            }),
          ),
      };
    }
    if (timelineSelection?.kind === 'page') {
      const index = Math.max(
        0,
        pagesForTimeline.findIndex((page) => page.id === timelineSelection.id),
      );
      const page = pagesForTimeline[index];
      return {
        kind: 'page',
        id: timelineSelection.id,
        label: page?.label ?? 'Page',
        width: page?.width ?? 0,
        height: page?.height ?? 0,
        durationSeconds: page ? page.endSeconds - page.startSeconds : 0,
        index,
      };
    }
    if (timelineSelection?.kind === 'audio') {
      return {
        kind: 'audio',
        id: timelineSelection.id,
        label: String(audioSource?.metadata.filename ?? 'Narration'),
        durationSeconds:
          Number(audioSource?.metadata.durationSeconds ?? 0) || 0,
        mediaType: String(audioSource?.metadata.mediaType ?? 'audio'),
      };
    }
    if (timelineSelection?.kind === 'caption') {
      const dialogue = reviewDialogues.find(
        (item) => item.id === timelineSelection.id,
      );
      if (dialogue) {
        return {
          kind: 'caption',
          id: dialogue.id,
          text: dialogue.caption,
          startSeconds: dialogue.start,
          endSeconds: dialogue.end,
          fontFamily: dialogue.fontFamily,
          fontSizePx: dialogue.fontSizePx,
          ...(dialogue.words ? { words: dialogue.words } : {}),
          estimated: !dialogue.words?.length,
          onTextChange: (value) =>
            window.dispatchEvent(
              new CustomEvent('comic-editor-caption-text', {
                detail: { id: dialogue.id, text: value },
              }),
            ),
          onTimeChange: (start, end) =>
            window.dispatchEvent(
              new CustomEvent('comic-editor-caption-time', {
                detail: { id: dialogue.id, start, end },
              }),
            ),
          onFontSizeChange: (value) =>
            window.dispatchEvent(
              new CustomEvent('comic-editor-caption-font', {
                detail: { id: dialogue.id, fontSizePx: value },
              }),
            ),
          onWordsChange: (words) =>
            window.dispatchEvent(
              new CustomEvent('comic-editor-caption-words', {
                detail: { id: dialogue.id, words },
              }),
            ),
        };
      }
    }
    return { kind: 'none' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    liveSelection,
    timelineSelection,
    pagesForTimeline,
    audioSource,
    reviewDialogues.length,
  ]);

  const reviewLayouts = (activeProject?.captionLayouts ??
    []) as readonly CaptionLayout[];
  const videoExportTimeline = useMemo(() => {
    const document = editorDocumentRef.current;
    if (!document) return { captions: [], bubbles: [] };
    return exportTimelineData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref-based document + activeProject
  }, [editorDocument, activeProject]);
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
      words: segment.words.map((word) => ({
        text: word.text,
        start: word.start.value,
        end: word.end.value,
      })),
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
    <div
      className="editor-app"
      data-theme={editorTheme}
      data-inspector={inspectorOpen ? 'on' : 'off'}
      data-timeline={timelineCollapsed ? 'collapsed' : 'expanded'}
      data-canvas-backdrop={canvasBackdrop ? 'on' : 'off'}
    >
      {/* Headless audio engine: drives playback, import, and transcription. */}
      <AudioWorkspace
        bare
        onAudioControls={(controls) => {
          audioControlsRef.current = controls;
        }}
        onAudioAsset={(asset) => {
          setAudioSource({
            metadata: asset.metadata as unknown as Record<string, unknown>,
            blob: asset.blob,
          });
        }}
        onClockChange={setAudioClock}
        onTranscriptChange={(transcript) => setSavedTranscript(transcript)}
        seekRequest={seekRequest}
      />
      <header className="editor-toolbar">
        <div className="editor-toolbar-left">
          <button
            className="ui-btn icon"
            type="button"
            aria-label="Undo"
            disabled={!canUndo}
            title={
              canUndo
                ? `Undo (${editorHistoryStatus.undoDepth} step${editorHistoryStatus.undoDepth === 1 ? '' : 's'})${editorHistoryStatus.undoPreview[0] ? ` → ${editorHistoryStatus.undoPreview[0]}` : ''}`
                : 'Undo'
            }
            onClick={() => window.dispatchEvent(new CustomEvent('comic-editor-undo'))}
          >
            <IconUndo />
            {editorHistoryStatus.undoDepth > 0 ? (
              <span
                style={{
                  marginLeft: 2,
                  fontSize: 9,
                  fontWeight: 700,
                  color: 'var(--ui-accent)',
                }}
              >
                {editorHistoryStatus.undoDepth}
              </span>
            ) : null}
          </button>
          <button
            className="ui-btn icon"
            type="button"
            aria-label="Redo"
            disabled={!canRedo}
            title={
              canRedo
                ? `Redo (${editorHistoryStatus.redoDepth} step${editorHistoryStatus.redoDepth === 1 ? '' : 's'})${editorHistoryStatus.redoPreview[0] ? ` → ${editorHistoryStatus.redoPreview[0]}` : ''}`
                : 'Redo'
            }
            onClick={() => window.dispatchEvent(new CustomEvent('comic-editor-redo'))}
          >
            <IconRedo />
            {editorHistoryStatus.redoDepth > 0 ? (
              <span
                style={{
                  marginLeft: 2,
                  fontSize: 9,
                  fontWeight: 700,
                  color: 'var(--ui-accent)',
                }}
              >
                {editorHistoryStatus.redoDepth}
              </span>
            ) : null}
          </button>
          {editorHistoryStatus.undoDepth + editorHistoryStatus.redoDepth > 0 ? (
            <details
              style={{ position: 'relative' }}
              title="Undo / redo stack"
            >
              <summary
                className="ui-btn icon"
                style={{ listStyle: 'none', cursor: 'pointer' }}
                aria-label="History stack"
              >
                ≡
              </summary>
              <div
                style={{
                  position: 'absolute',
                  top: 36,
                  left: 0,
                  zIndex: 60,
                  minWidth: 200,
                  maxHeight: 240,
                  overflow: 'auto',
                  padding: 8,
                  border: '1px solid var(--ui-border)',
                  borderRadius: 10,
                  background: 'var(--ui-surface)',
                  boxShadow: 'var(--ui-shadow)',
                  fontSize: 11,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  History stack
                </div>
                {editorHistoryStatus.undoPreview.length === 0 &&
                editorHistoryStatus.redoPreview.length === 0 ? (
                  <div style={{ color: 'var(--ui-muted)' }}>No steps</div>
                ) : (
                  <>
                    {editorHistoryStatus.undoPreview.map((label, index) => (
                      <div
                        key={`u-${index}-${label}`}
                        style={{ color: 'var(--ui-muted)', marginBottom: 2 }}
                      >
                        ← {label}
                      </div>
                    ))}
                    <div style={{ margin: '6px 0', fontWeight: 700 }}>
                      Now
                    </div>
                    {editorHistoryStatus.redoPreview.map((label, index) => (
                      <div
                        key={`r-${index}-${label}`}
                        style={{ color: 'var(--ui-accent)', marginBottom: 2 }}
                      >
                        → {label}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </details>
          ) : null}
        </div>
        <div className="editor-toolbar-center">
          <div className="editor-brand">
            <div className="editor-brand-mark">CC</div>
            <div className="editor-brand-text">
              <div className="editor-brand-title">
                {activeProject?.name ?? 'Untitled motion comic'}
              </div>
              <div className="editor-brand-sub">
                {activeProject
                  ? `Saved locally · rev ${activeProject.revision}`
                  : 'Unsaved project'}
              </div>
            </div>
          </div>
        </div>
        <div className="editor-toolbar-right">
          <button
            className="ui-btn icon"
            type="button"
            aria-label="Zoom out"
            onClick={() => setCanvasZoom((value) => Math.max(25, value - 10))}
          >
            <IconZoomOut />
          </button>
          <select
            className="ui-select"
            aria-label="Canvas zoom"
            value={String(canvasZoom)}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'auto') setCanvasZoom(100);
              else setCanvasZoom(Number(value));
            }}
          >
            <option value="auto">Auto</option>
            <option value="50">50%</option>
            <option value="75">75%</option>
            <option value="100">100%</option>
            <option value="125">125%</option>
            <option value="150">150%</option>
          </select>
          <button
            className="ui-btn icon"
            type="button"
            aria-label="Zoom in"
            onClick={() => setCanvasZoom((value) => Math.min(200, value + 10))}
          >
            <IconZoomIn />
          </button>
          <button
            className="ui-btn icon"
            type="button"
            aria-label="Toggle theme"
            title="Toggle light/dark theme"
            onClick={() =>
              setEditorTheme((value) => (value === 'light' ? 'dark' : 'light'))
            }
          >
            <IconTheme />
          </button>
          <button
            className="ui-btn primary"
            type="button"
            disabled={savingProject}
            onClick={() => {
              setSavingProject(true);
              void saveProject().finally(() => setSavingProject(false));
            }}
          >
            <IconSave size={14} /> {savingProject ? 'Saving…' : 'Save'}
          </button>
          <button
            className="ui-btn icon"
            type="button"
            aria-label="Toggle inspector"
            onClick={() => setInspectorOpen((value) => !value)}
          >
            <IconLayers />
          </button>
        </div>
      </header>

      <nav className="editor-rail" aria-label="Tools">
        {(
          [
            ['pages', 'Pages', IconPages],
            ['layers', 'Layers', IconLayers],
            ['import', 'Import pages', IconUpload],
            ['audio', 'Narration', IconAudio],
            ['media', 'Media', IconImage],
            ['video', 'Composition', IconVideo],
            ['captions', 'Captions', IconText],
            ['bubbles', 'Bubbles', IconBubble],
            ['ocr', 'OCR / Detect', IconOcr],
            ['export', 'Export', IconSave],
            ['settings', 'Settings', IconTheme],
          ] as const
        ).map(([id, label, RailIcon]) => (
          <button
            key={id}
            type="button"
            className={`rail-btn ${activeTool === id ? 'active' : ''}`}
            aria-label={label}
            aria-pressed={activeTool === id}
            title={label}
            onClick={() => {
              setActiveTool(id);
              setInspectorOpen(true);
              if (id === 'settings') {
                // Inspector Project tab shows theme + project settings.
                setTimelineSelection(null);
              }
            }}
          >
            <RailIcon />
            <span className="tooltip">{label}</span>
          </button>
        ))}
      </nav>

      <div className="editor-stage">
        <div className="stage-hud">
          <span>
            Zoom {canvasZoom}% · {pagesForTimeline.length} page
            {pagesForTimeline.length === 1 ? '' : 's'}
          </span>
          <span>{activeTool}</span>
        </div>
        <div
          style={{
            width: '100%',
            height: '100%',
            overflow: 'hidden',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
        <div className="canvas-bar" role="toolbar" aria-label="Canvas bar">
          <button
            className="ui-btn"
            type="button"
            onClick={() => {
              setCanvasZoom(100);
              setProjectMessage('Canvas fit to 100%.');
            }}
          >
            Fit
          </button>
          <button
            className="ui-btn"
            type="button"
            onClick={() => void addEmptyPage()}
          >
            + Add page
          </button>
          <button
            className="ui-btn"
            type="button"
            onClick={() => {
              setActiveTool('pages');
              setInspectorOpen(true);
            }}
          >
            Page settings
          </button>
          <div className="canvas-bar-spacer" />
          <div className="playback-bar" role="toolbar" aria-label="Playback">
            <button
              className="ui-btn icon"
              type="button"
              title="Go to beginning · Home"
              aria-label="Go to beginning"
              onClick={() =>
                setSeekRequest((previous) => ({
                  time: 0,
                  revision: (previous?.revision ?? 0) + 1,
                }))
              }
            >
              |◀
            </button>
            <button
              className="ui-btn icon"
              type="button"
              title="Back 1s"
              aria-label="Back 1 second"
              onClick={() =>
                setSeekRequest((previous) => ({
                  time: Math.max(0, (audioClock.positionSeconds ?? 0) - 1),
                  revision: (previous?.revision ?? 0) + 1,
                }))
              }
            >
              ‹
            </button>
            <button
              className="ui-btn icon primary"
              type="button"
              title="Play or pause · Space"
              aria-label={audioClock.status === 'playing' ? 'Pause playback' : 'Play playback'}
              disabled={!audioSource?.blob}
              onClick={() => void audioControlsRef.current?.toggle()}
            >
              {audioClock.status === 'playing' ? '❚❚' : '▶'}
            </button>
            <button
              className="ui-btn icon"
              type="button"
              title="Forward 1s"
              aria-label="Forward 1 second"
              onClick={() =>
                setSeekRequest((previous) => ({
                  time: Math.min(
                    audioClock.durationSeconds || 0,
                    (audioClock.positionSeconds ?? 0) + 1,
                  ),
                  revision: (previous?.revision ?? 0) + 1,
                }))
              }
            >
              ›
            </button>
            <button
              className="ui-btn icon"
              type="button"
              title="Go to end · End"
              aria-label="Go to end"
              onClick={() =>
                setSeekRequest((previous) => ({
                  time: audioClock.durationSeconds || 0,
                  revision: (previous?.revision ?? 0) + 1,
                }))
              }
            >
              ▶|
            </button>
            <span className="playback-time" aria-live="off">
              {formatPlaybackTime(audioClock.positionSeconds)} /{' '}
              {formatPlaybackTime(
                audioClock.durationSeconds ||
                  Number(audioSource?.metadata.durationSeconds ?? 0),
              )}
            </span>
            <input
              aria-label="Playback position"
              className="playback-scrubber"
              type="range"
              min={0}
              max={audioClock.durationSeconds || Number(audioSource?.metadata.durationSeconds ?? 0) || 1}
              step={0.01}
              value={Math.min(
                audioClock.positionSeconds,
                audioClock.durationSeconds ||
                  Number(audioSource?.metadata.durationSeconds ?? 0) ||
                  0,
              )}
              disabled={!audioSource?.blob}
              onChange={(event) =>
                setSeekRequest((previous) => ({
                  time: Number(event.currentTarget.value),
                  revision: (previous?.revision ?? 0) + 1,
                }))
              }
            />
            <button
              className={`ui-btn icon ${playbackLoop ? 'active' : ''}`}
              type="button"
              title="Loop playback"
              aria-label="Loop playback"
              aria-pressed={playbackLoop}
              onClick={() => setPlaybackLoop((value) => !value)}
            >
              ↻
            </button>
            <button
              className="ui-btn"
              type="button"
              title="Import narration audio"
              onClick={() => audioControlsRef.current?.import()}
            >
              {audioSource ? 'Replace audio' : 'Import audio'}
            </button>
          </div>
          {activeTranscriptSegment?.text ? (
            <span className="live-transcript" aria-live="polite">
              {activeTranscriptSegment.text}
            </span>
          ) : null}
        </div>
        {/* IMG.LY-style workspace: tool drawer + canvas. No legacy card stack. */}
        {projectMessage && (
          <div
            className="canvas-bar"
            role="status"
            style={{ justifyContent: 'space-between' }}
          >
            <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
              {projectMessage}
            </span>
            <button
              className="ui-btn icon ghost"
              type="button"
              aria-label="Dismiss message"
              onClick={() => setProjectMessage(null)}
            >
              ×
            </button>
          </div>
        )}
        {error && (
          <div className="canvas-bar" role="alert">
            <span style={{ color: 'var(--ui-danger)', fontSize: 12 }}>{error}</span>
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: 12,
            minHeight: 0,
            flex: 1,
            alignItems: 'stretch',
            marginTop: 10,
          }}
        >
          <ToolDrawer
            tool={activeTool}
            onClose={() => setActiveTool('canvas')}
          >
            {(activeTool === 'pages' || activeTool === 'layers' || activeTool === 'canvas') && (
              <ToolDrawerSection title="Page strip">
                <ToolDrawerRow>
                  <button className="ui-btn" type="button" onClick={() => void addEmptyPage()}>
                    + Add page
                  </button>
                  <button
                    className="ui-btn"
                    type="button"
                    onClick={() => pageImportInputRef.current?.click()}
                  >
                    Import…
                  </button>
                  <input
                    ref={pageImportInputRef}
                    className="ui-sr"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      const files = [...(event.currentTarget.files ?? [])];
                      event.currentTarget.value = '';
                      if (files.length > 0) void importPageFiles(files);
                    }}
                  />
                </ToolDrawerRow>
                <ToolDrawerRow stacked>
                  {pagesForTimeline.map((page, index) => (
                    <div
                      key={page.id}
                      style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      <button
                        type="button"
                        className={`page-chip ${page.id === activePageId ? 'selected' : ''}`}
                        style={{ flex: 1 }}
                        onClick={() => void activatePage(page.id)}
                      >
                        {index + 1}. {page.label}
                      </button>
                      <button
                        className="ui-btn icon"
                        type="button"
                        aria-label={`Move ${page.label} earlier`}
                        disabled={index === 0}
                        onClick={() => {
                          void flushActivePage().then(() => {
                            setProjectPages((pages) =>
                              movePage(pages, page.id, -1),
                            );
                          });
                        }}
                      >
                        ←
                      </button>
                      <button
                        className="ui-btn icon"
                        type="button"
                        aria-label={`Move ${page.label} later`}
                        disabled={index === pagesForTimeline.length - 1}
                        onClick={() => {
                          void flushActivePage().then(() => {
                            setProjectPages((pages) =>
                              movePage(pages, page.id, 1),
                            );
                          });
                        }}
                      >
                        →
                      </button>
                    </div>
                  ))}
                  {pagesForTimeline.length === 0 ? (
                    <p style={{ fontSize: 11, color: 'var(--ui-muted)', margin: 0 }}>
                      No pages yet.
                    </p>
                  ) : null}
                </ToolDrawerRow>
              </ToolDrawerSection>
            )}
            {activeTool === 'import' && (
              <ToolDrawerSection title="Import">
                <ToolDrawerRow stacked>
                  <ImageUploadControl
                    busy={busyRole === 'original'}
                    label="Original page"
                    onSelect={(file) => void importImage('original', file)}
                  />
                  <ImageUploadControl
                    busy={busyRole === 'cleaned'}
                    label="Cleaned page (optional)"
                    onSelect={(file) => void importImage('cleaned', file)}
                  />
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={!pair.original || autoCleanBusy || busyRole !== null}
                    onClick={() => void autoCleanFromOriginal()}
                  >
                    {autoCleanBusy ? 'Auto-cleaning…' : 'Auto-clean page'}
                  </button>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={!pair.original || !pair.cleaned || alignmentBusy}
                    onClick={() => void runAlignment()}
                  >
                    {alignmentBusy ? 'Aligning…' : 'Align pages'}
                  </button>
                </ToolDrawerRow>
                {alignment && alignmentImages && original && (
                  <ToolDrawerRow stacked>
                    <AlignmentReview
                      alignment={alignment}
                      image={{ ...original, src: alignmentImages[alignmentMode] }}
                      mode={alignmentMode}
                      onModeChange={setAlignmentMode}
                      onSave={saveManualAlignment}
                    />
                  </ToolDrawerRow>
                )}
                {pair.original && (
                  <ToolDrawerRow stacked>
                    <LetteringCleanupReview
                      originalUrl={sourceUrls.original ?? null}
                      cleanedUrl={sourceUrls.cleaned ?? null}
                      maskUrl={letteringMaskUrl}
                      result={letteringResult}
                      busy={autoCleanBusy || pageAnalysisBusy}
                      accepted={letteringAccepted}
                      showMask={showRemovalMask}
                      maskEditMode={letteringMaskEdit}
                      pageWidth={pair.original.dimensions.width}
                      pageHeight={pair.original.dimensions.height}
                      onToggleMask={() => setShowRemovalMask((value) => !value)}
                      onSetMaskEditMode={(mode) => setLetteringMaskEdit(mode)}
                      onPaintMask={(mode, x, y, radius) =>
                        paintLetteringMask(mode, x, y, radius)
                      }
                      onApplyMaskEdits={() => {
                        letteringStrokeRef.current = null;
                        void reprocessLettering();
                      }}
                      onReprocessRegion={(regionId) => {
                        void reprocessLettering({ regionIds: [regionId] });
                      }}
                      onApproveRegions={(regionIds) => {
                        const approved = [
                          ...new Set([...letteringApprovedIds, ...regionIds]),
                        ];
                        setLetteringApprovedIds(approved);
                        void reprocessLettering({
                          regionIds,
                          approvedRegionIds: approved,
                          erasureScope: 'approved',
                        });
                      }}
                      onResetEdits={() => {
                        letteringStrokeRef.current = null;
                        setLetteringManualAdds([]);
                        setLetteringManualExcludes([]);
                        setLetteringApprovedIds([]);
                        void reprocessLettering({
                          manualAdds: [],
                          manualExcludes: [],
                          approvedRegionIds: [],
                          resetApproved: true,
                        });
                      }}
                      onAccept={() => {
                        setLetteringAccepted(true);
                        setProjectMessage('Clean page accepted.');
                      }}
                      onReject={() => {
                        setLetteringAccepted(false);
                        setLetteringResult(null);
                        setProjectMessage('Clean page rejected.');
                      }}
                    />
                  </ToolDrawerRow>
                )}
              </ToolDrawerSection>
            )}
            {activeTool === 'ocr' && (
              <ToolDrawerSection title="Detect">
                <ToolDrawerRow>
                  <button
                    className="ui-btn primary"
                    type="button"
                    disabled={(!pair.original && !pair.cleaned) || pageAnalysisBusy}
                    onClick={() => void detectBubbles()}
                  >
                    {pageAnalysisBusy ? 'Scanning…' : 'Detect bubbles'}
                  </button>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={!pair.original || pageAnalysisBusy}
                    onClick={() => void analyzePage()}
                  >
                    Analyze page
                  </button>
                </ToolDrawerRow>
                <ToolDrawerRow>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={(!pair.original && !pair.cleaned) || ocrStatus?.phase === 'recognizing'}
                    onClick={() => void extractText()}
                  >
                    Extract text
                  </button>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={(!pair.original && !pair.cleaned) || ocrStatus?.phase === 'recognizing'}
                    onClick={() => void scanAndExtract()}
                  >
                    Scan + extract
                  </button>
                </ToolDrawerRow>
                <ToolDrawerRow>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={(!pair.original && !pair.cleaned) || ocrStatus?.phase === 'recognizing'}
                    onClick={() => void retryEnhancedOCR()}
                  >
                    Enhanced OCR
                  </button>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={speechAutomationBusy || !audioSource?.blob}
                    onClick={() => void automateSpeech()}
                  >
                    {speechAutomationBusy ? 'Running…' : 'Auto everything'}
                  </button>
                </ToolDrawerRow>
                <ToolDrawerRow>
                  <label className="inspector-label">
                    Reading order
                    <select
                      className="ui-select"
                      value={readingDirection}
                      onChange={(event) =>
                        setReadingDirection(event.currentTarget.value as 'ltr' | 'rtl')
                      }
                    >
                      <option value="ltr">LTR</option>
                      <option value="rtl">RTL (manga)</option>
                    </select>
                  </label>
                </ToolDrawerRow>
                <ToolDrawerRow>
                  <label className="inspector-label">
                    Bubble proposals
                    <select
                      className="ui-select"
                      value={bubbleProposalSource}
                      onChange={(event) =>
                        setBubbleProposalSource(
                          event.target.value === 'ml' ? 'ml' : 'heuristic',
                        )
                      }
                    >
                      <option value="heuristic">Heuristic</option>
                      <option value="ml">ML (YOLO)</option>
                    </select>
                  </label>
                </ToolDrawerRow>
                {ocrStatus ? (
                  <p style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{ocrStatus.message}</p>
                ) : null}
                {ocrMetrics ? (
                  <p style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                    {ocrMetrics.detectedTextRegions} regions ·{' '}
                    {Math.round(ocrMetrics.averageConfidence * 100)}% mean confidence
                  </p>
                ) : null}
                {speechAutomationWarning ? (
                  <p style={{ fontSize: 11, color: 'var(--ui-danger)' }}>
                    {speechAutomationWarning}
                  </p>
                ) : null}
                {ocrReviewItems.length > 0 ? (
                  <p style={{ fontSize: 11, color: 'var(--ui-accent)' }}>
                    OCR review queue · {ocrReviewItems.length}
                  </p>
                ) : null}
                {alignment && original && textDebugUrl != null && (
                  <ToolDrawerRow stacked>
                    <TextDifferenceReview
                      debugUrl={textDebugUrl}
                      image={original}
                      onDetect={() => void detectRemovedText()}
                      regions={textRegions}
                      running={textDetectionBusy}
                    />
                  </ToolDrawerRow>
                )}
              </ToolDrawerSection>
            )}
            {activeTool === 'captions' && (
              <ToolDrawerSection title="Captions">
                <ToolDrawerRow>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={!savedTranscript || !editorDocument}
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent('comic-editor-suggest-matches'),
                      );
                      setProjectMessage(
                        'Dialogue match suggestions requested. Review them on the canvas.',
                      );
                    }}
                  >
                    Suggest dialogue matches
                  </button>
                </ToolDrawerRow>
                {activeReviewText ? (
                  <ToolDrawerRow stacked>
                    <p style={{ fontSize: 12, margin: 0 }}>{activeReviewText}</p>
                    <p style={{ fontSize: 11, color: 'var(--ui-muted)', margin: 0 }}>
                      {activeReviewLayout
                        ? `Fitted · ${activeReviewLayout.fontSizePx}px · ${activeReviewLayout.lines.length} lines`
                        : 'Layout needed'}
                    </p>
                    {activeTranscriptMapping ? (
                      <button
                        className="ui-btn"
                        type="button"
                        onClick={() =>
                          approveLiveMapping(activeTranscriptMapping)
                        }
                      >
                        Approve mapping
                      </button>
                    ) : null}
                  </ToolDrawerRow>
                ) : null}
                <ToolDrawerRow stacked>
                  {reviewDialogues.length === 0 ? (
                    <p style={{ fontSize: 11, color: 'var(--ui-muted)', margin: 0 }}>
                      No captions yet. Detect bubbles and map transcript lines.
                    </p>
                  ) : (
                    reviewDialogues.map((dialogue, index) => (
                      <button
                        key={dialogue.id}
                        type="button"
                        className={`page-chip ${timelineSelection?.kind === 'caption' && timelineSelection.id === dialogue.id ? 'selected' : ''}`}
                        onClick={() => {
                          setTimelineSelection({
                            kind: 'caption',
                            id: dialogue.id,
                          });
                          window.dispatchEvent(
                            new CustomEvent('comic-editor-selection', {
                              detail: {
                                kind: 'caption',
                                bubbleId: dialogue.bubbleId,
                                dialogueId: dialogue.id,
                                bubble: null,
                                caption: {
                                  id: dialogue.id,
                                  text: dialogue.caption,
                                  startSeconds: dialogue.start,
                                  endSeconds: dialogue.end,
                                  fontFamily: dialogue.fontFamily,
                                  fontSizePx: dialogue.fontSizePx,
                                },
                              },
                            }),
                          );
                          setSeekRequest((previous) => ({
                            time: dialogue.start,
                            revision: (previous?.revision ?? 0) + 1,
                          }));
                        }}
                      >
                        {index + 1}. {dialogue.caption.slice(0, 28) || 'Untitled'}
                        <span style={{ opacity: 0.7 }}>
                          {' '}
                          · {dialogue.start.toFixed(1)}–{dialogue.end.toFixed(1)}s
                        </span>
                      </button>
                    ))
                  )}
                </ToolDrawerRow>
                <p style={{ fontSize: 11, color: 'var(--ui-muted)', margin: '8px 0 0' }}>
                  Select a bubble or caption on the canvas to edit text and timing.
                </p>
              </ToolDrawerSection>
            )}
            {activeTool === 'bubbles' && (
              <ToolDrawerSection title="Bubbles">
                <ToolDrawerRow>
                  <button
                    className="ui-btn"
                    type="button"
                    disabled={(!pair.original && !pair.cleaned) || pageAnalysisBusy}
                    onClick={() => void detectBubbles()}
                  >
                    {pageAnalysisBusy ? 'Scanning…' : 'Detect bubbles'}
                  </button>
                </ToolDrawerRow>
                <ToolDrawerRow stacked>
                  {Object.values(editorDocument?.bubbles ?? {}).length === 0 ? (
                    <p style={{ fontSize: 11, color: 'var(--ui-muted)', margin: 0 }}>
                      No bubbles yet. Run Detect bubbles on the OCR tool.
                    </p>
                  ) : (
                    Object.values(editorDocument?.bubbles ?? {}).map(
                      (bubble, index) => {
                        const dialogue =
                          editorDocument?.dialogues[`dialogue:${bubble.id}`];
                        return (
                          <button
                            key={bubble.id}
                            type="button"
                            className="page-chip"
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent('comic-editor-selection', {
                                  detail: {
                                    kind: 'bubble',
                                    bubbleId: bubble.id,
                                    dialogueId: `dialogue:${bubble.id}`,
                                    bubble: {
                                      id: bubble.id,
                                      kind: bubble.kind,
                                      confidence: bubble.confidence ?? null,
                                      boundingBox: bubble.boundingBox,
                                    },
                                    caption: dialogue
                                      ? {
                                          id: dialogue.id,
                                          text: dialogue.caption,
                                          startSeconds: dialogue.start,
                                          endSeconds: dialogue.end,
                                          fontFamily: dialogue.fontFamily,
                                          fontSizePx: dialogue.fontSizePx,
                                        }
                                      : null,
                                  },
                                }),
                              );
                            }}
                          >
                            {index + 1}. {bubble.kind} ·{' '}
                            {Math.round((bubble.confidence ?? 0) * 100)}%
                          </button>
                        );
                      },
                    )
                  )}
                </ToolDrawerRow>
                <p style={{ fontSize: 11, color: 'var(--ui-muted)', margin: '8px 0 0' }}>
                  Select one to edit bounds and class in the inspector.
                </p>
              </ToolDrawerSection>
            )}
            {activeTool === 'audio' && (
              <ToolDrawerSection title="Narration">
                <ToolDrawerRow>
                  <button
                    className="ui-btn"
                    type="button"
                    onClick={() => audioControlsRef.current?.import()}
                  >
                    {audioSource ? 'Replace audio' : 'Import audio'}
                  </button>
                  <button
                    className="ui-btn primary"
                    type="button"
                    disabled={!audioSource?.blob}
                    onClick={() => void audioControlsRef.current?.toggle()}
                  >
                    {audioClock.status === 'playing' ? 'Pause' : 'Play'}
                  </button>
                </ToolDrawerRow>
                <ToolDrawerRow>
                  <span className="inspector-label">
                    {String(audioSource?.metadata.filename ?? loadedAudioFile?.name ?? 'No audio loaded')}
                    {audioSessionRevision > 0 ? ` · rev ${audioSessionRevision}` : ''}
                  </span>
                </ToolDrawerRow>
                {audioSource ? (
                  <>
                    <ToolDrawerRow>
                      <span className="inspector-label">
                        {Number(audioSource.metadata.durationSeconds ?? 0).toFixed(2)}s
                        {savedTranscript ? ' · transcript ready' : ' · no transcript'}
                      </span>
                    </ToolDrawerRow>
                    <ToolDrawerRow stacked>
                      <input
                        aria-label="Audio position"
                        className="playback-scrubber"
                        type="range"
                        min={0}
                        max={
                          audioClock.durationSeconds ||
                          Number(audioSource.metadata.durationSeconds ?? 0) ||
                          1
                        }
                        step={0.01}
                        value={Math.min(
                          audioClock.positionSeconds,
                          audioClock.durationSeconds ||
                            Number(audioSource.metadata.durationSeconds ?? 0) ||
                            0,
                        )}
                        onChange={(event) =>
                          setSeekRequest((previous) => ({
                            time: Number(event.currentTarget.value),
                            revision: (previous?.revision ?? 0) + 1,
                          }))
                        }
                      />
                      <button
                        className="ui-btn"
                        type="button"
                        disabled={speechAutomationBusy}
                        onClick={() => {
                          void audioControlsRef.current?.transcribe().then((result) => {
                            if (result) setSavedTranscript(result);
                          });
                        }}
                      >
                        Generate transcript
                      </button>
                      {activeTranscriptSegment?.text ? (
                        <p
                          aria-live="polite"
                          style={{
                            fontSize: 11,
                            color: 'var(--ui-accent)',
                            margin: 0,
                            lineHeight: 1.4,
                          }}
                        >
                          {activeTranscriptSegment.text}
                        </p>
                      ) : null}
                    </ToolDrawerRow>
                  </>
                ) : (
                  <p style={{ fontSize: 11, color: 'var(--ui-muted)', margin: 0 }}>
                    Import narration audio to enable playback and transcription.
                  </p>
                )}
              </ToolDrawerSection>
            )}
            {activeTool === 'export' && (
              <ToolDrawerSection title="Export">
                <ToolDrawerRow>
                  <select
                    aria-label="MP4 export resolution"
                    className="ui-select"
                    disabled={mp4Exporting}
                    value={mp4Resolution}
                    onChange={(event) =>
                      setMp4Resolution(event.currentTarget.value as Mp4Resolution)
                    }
                  >
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                    <option value="custom">Custom</option>
                  </select>
                  {mp4Resolution === 'custom' ? (
                    <>
                      <input
                        aria-label="Custom video width"
                        className="inspector-field"
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
                        className="inspector-field"
                        type="number"
                        min="16"
                        max="7680"
                        step="2"
                        value={customVideoHeight}
                        onChange={(event) =>
                          setCustomVideoHeight(event.currentTarget.value)
                        }
                      />
                    </>
                  ) : null}
                </ToolDrawerRow>
                {mp4Progress ? (
                  <ToolDrawerRow>
                    <progress
                      aria-label="MP4 export progress"
                      className="w-28"
                      max="100"
                      value={mp4Progress.percent}
                    />
                    <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                      {Math.floor(mp4Progress.percent)}%
                    </span>
                  </ToolDrawerRow>
                ) : null}
                <ToolDrawerRow stacked>
                  <button
                    className="ui-btn"
                    disabled={!activeProject}
                    onClick={() => void exportProject()}
                  >
                    Project archive
                  </button>
                  <button
                    className="ui-btn"
                    disabled={!pair.original || !editorDocument}
                    onClick={() => void exportFrame('png')}
                  >
                    PNG frame
                  </button>
                  <button
                    className="ui-btn primary"
                    disabled={
                      (!pair.original && !pair.cleaned) ||
                      !audioSource?.blob ||
                      !editorDocument ||
                      autoCleanBusy
                    }
                    onClick={() => void exportVideo()}
                  >
                    {mp4Exporting ? 'Exporting MP4…' : 'Export MP4 (FFmpeg)'}
                  </button>
                  <VideoExportPanel
                    pageBlob={sourceBlobs.cleaned ?? sourceBlobs.original ?? null}
                    pageWidth={
                      pair.cleaned?.dimensions.width ??
                      pair.original?.dimensions.width ??
                      1280
                    }
                    pageHeight={
                      pair.cleaned?.dimensions.height ??
                      pair.original?.dimensions.height ??
                      720
                    }
                    audioBlob={audioSource?.blob ?? null}
                    audioFormat={String(audioSource?.metadata.format ?? 'wav')}
                    durationSeconds={
                      Number(audioSource?.metadata.durationSeconds ?? 0) || 0
                    }
                    captions={videoExportTimeline.captions}
                    bubbles={videoExportTimeline.bubbles}
                    panels={pageAnalysis?.panels ?? []}
                    sourcePages={multiPagePlan.sourcePages}
                    multiPageWarnings={multiPagePlan.warnings}
                    projectName={activeProject?.name ?? 'comic'}
                    disabled={mp4Exporting || autoCleanBusy}
                    onMessage={setProjectMessage}
                  />
                </ToolDrawerRow>
              </ToolDrawerSection>
            )}
            {activeTool === 'settings' && (
              <ToolDrawerSection title="Project">
                <ToolDrawerRow stacked>
                  <button className="ui-btn" onClick={createNewProject} type="button">
                    New project
                  </button>
                  <select
                    aria-label="Open saved project"
                    className="ui-select"
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
                    className="ui-btn"
                    onClick={() => {
                      const name = window.prompt(
                        'Save project as',
                        `${activeProject?.name ?? 'Comic'} copy`,
                      );
                      if (name) void saveProjectAs(name);
                    }}
                    type="button"
                  >
                    Save as…
                  </button>
                  <button
                    className="ui-btn"
                    disabled={!activeProject?.revision}
                    onClick={() => void duplicateProject()}
                    type="button"
                  >
                    Duplicate
                  </button>
                  <button
                    className="ui-btn"
                    onClick={() => projectImportRef.current?.click()}
                    type="button"
                  >
                    Import archive
                  </button>
                  <input
                    ref={projectImportRef}
                    className="ui-sr"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      void importProjectFile(event.currentTarget.files?.[0]);
                      event.currentTarget.value = '';
                    }}
                  />
                </ToolDrawerRow>
                <ToolDrawerRow>
                  <button
                    className="ui-btn"
                    type="button"
                    onClick={() =>
                      setEditorTheme((value) => (value === 'light' ? 'dark' : 'light'))
                    }
                  >
                    Theme: {editorTheme}
                  </button>
                </ToolDrawerRow>
              </ToolDrawerSection>
            )}
            {activeTool === 'media' && (
              <ToolDrawerSection title="Media">
                <ToolDrawerRow stacked>
                  <ImageUploadControl
                    busy={busyRole === 'original'}
                    label="Original page"
                    onSelect={(file) => void importImage('original', file)}
                  />
                  <ImageUploadControl
                    busy={busyRole === 'cleaned'}
                    label="Cleaned page"
                    onSelect={(file) => void importImage('cleaned', file)}
                  />
                </ToolDrawerRow>
                <ToolDrawerRow stacked>
                  {sourceUrls.original ? (
                    <figure style={{ margin: 0 }}>
                      <img
                        alt="Original page thumbnail"
                        src={sourceUrls.original}
                        style={{
                          width: '100%',
                          borderRadius: 6,
                          border: '1px solid var(--ui-border)',
                        }}
                      />
                      <figcaption
                        style={{ fontSize: 11, color: 'var(--ui-muted)' }}
                      >
                        Original · {pair.original?.dimensions.width ?? 0}×
                        {pair.original?.dimensions.height ?? 0}
                      </figcaption>
                    </figure>
                  ) : null}
                  {sourceUrls.cleaned ? (
                    <figure style={{ margin: 0 }}>
                      <img
                        alt="Cleaned page thumbnail"
                        src={sourceUrls.cleaned}
                        style={{
                          width: '100%',
                          borderRadius: 6,
                          border: '1px solid var(--ui-border)',
                        }}
                      />
                      <figcaption
                        style={{ fontSize: 11, color: 'var(--ui-muted)' }}
                      >
                        Cleaned · {pair.cleaned?.dimensions.width ?? 0}×
                        {pair.cleaned?.dimensions.height ?? 0}
                      </figcaption>
                    </figure>
                  ) : null}
                  {!sourceUrls.original && !sourceUrls.cleaned ? (
                    <p
                      style={{
                        fontSize: 11,
                        color: 'var(--ui-muted)',
                        margin: 0,
                      }}
                    >
                      No page media yet. Import an original or cleaned comic
                      page.
                    </p>
                  ) : null}
                </ToolDrawerRow>
              </ToolDrawerSection>
            )}
            {activeTool === 'video' && (
              <ToolDrawerSection title="Composition">
                <ToolDrawerRow>
                  <span className="inspector-label">
                    {pagesForTimeline.length} page
                    {pagesForTimeline.length === 1 ? '' : 's'} ·{' '}
                    {multiPagePlan.sourcePages.length} source clip
                    {multiPagePlan.sourcePages.length === 1 ? '' : 's'}
                  </span>
                </ToolDrawerRow>
                <ToolDrawerRow stacked>
                  {multiPagePlan.sourcePages.map((source, index) => (
                    <button
                      key={source.id}
                      type="button"
                      className={`page-chip ${timelineSelection?.kind === 'page' && timelineSelection.id === source.id ? 'selected' : ''}`}
                      onClick={() => {
                        setTimelineSelection({ kind: 'page', id: source.id });
                        void activatePage(source.id);
                        setSeekRequest((previous) => ({
                          time: source.startSeconds,
                          revision: (previous?.revision ?? 0) + 1,
                        }));
                      }}
                    >
                      {index + 1}. {source.startSeconds.toFixed(1)}–
                      {source.endSeconds.toFixed(1)}s
                    </button>
                  ))}
                  {multiPagePlan.sourcePages.length === 0 ? (
                    <p
                      style={{
                        fontSize: 11,
                        color: 'var(--ui-muted)',
                        margin: 0,
                      }}
                    >
                      No pages in the composition yet. Import pages first.
                    </p>
                  ) : null}
                </ToolDrawerRow>
                {multiPagePlan.warnings.length > 0 ? (
                  <ToolDrawerRow stacked>
                    {multiPagePlan.warnings.map((warning) => (
                      <p
                        key={warning}
                        style={{
                          fontSize: 11,
                          color: 'var(--ui-danger)',
                          margin: 0,
                        }}
                      >
                        {warning}
                      </p>
                    ))}
                  </ToolDrawerRow>
                ) : null}
                <ToolDrawerRow>
                  <button
                    className="ui-btn"
                    type="button"
                    onClick={() => {
                      setActiveTool('export');
                      setInspectorOpen(true);
                    }}
                  >
                    Open export tools
                  </button>
                </ToolDrawerRow>
              </ToolDrawerSection>
            )}
          </ToolDrawer>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {original || cleaned ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: 'auto',
                  border: '1px solid var(--ui-border)',
                  borderRadius: 12,
                  background: 'var(--ui-surface)',
                }}
              >
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
                  onDocumentChange={setEditorDocument}
                />
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid var(--ui-border)',
                  borderRadius: 12,
                  background: 'var(--ui-surface)',
                  color: 'var(--ui-muted)',
                }}
              >
                Import a comic page to edit bubbles and captions on the canvas.
              </div>
            )}
          </div>
        </div>
        </div>
      </div>

      <EditorInspector
        selection={inspectorSelection}
        theme={editorTheme}
        onThemeChange={setEditorTheme}
        projectName={activeProject?.name ?? 'Untitled motion comic'}
        pageCount={pagesForTimeline.length}
        durationSeconds={Number(audioSource?.metadata.durationSeconds ?? 0) || 0}
        fps={24}
        onClose={() => setInspectorOpen(false)}
      />

      <EditorTimeline
        durationSeconds={
          Number(audioSource?.metadata.durationSeconds ?? 0) ||
          Math.max(
            1,
            pagesForTimeline[pagesForTimeline.length - 1]?.endSeconds ?? 1,
          )
        }
        currentTime={audioClock.positionSeconds}
        playing={audioClock.status === 'playing'}
        collapsed={timelineCollapsed}
        heightPx={timelineHeight}
        zoom={timelineZoom}
        pages={pagesForTimeline}
        audioClips={
          audioSource
            ? [
                {
                  id: 'narration',
                  label: String(audioSource.metadata.filename ?? 'Narration'),
                  startSeconds: 0,
                  endSeconds:
                    Number(audioSource.metadata.durationSeconds ?? 0) || 1,
                  selected: timelineSelection?.kind === 'audio',
                },
              ]
            : []
        }
        captions={reviewDialogues.map((dialogue) => ({
          id: dialogue.id,
          label: dialogue.caption.slice(0, 24) || 'Caption',
          startSeconds: dialogue.start,
          endSeconds: dialogue.end,
          selected:
            timelineSelection?.kind === 'caption' &&
            timelineSelection.id === dialogue.id,
        }))}
        selectedClipId={timelineSelection?.id ?? null}
        loop={playbackLoop}
        showBackground={canvasBackdrop}
        onToggleLoop={() => setPlaybackLoop((value) => !value)}
        onToggleBackground={() =>
          setCanvasBackdrop((value) => {
            setProjectMessage(
              value
                ? 'Canvas background hidden.'
                : 'Canvas background restored.',
            );
            return !value;
          })
        }
        onSeek={(time) =>
          setSeekRequest((previous) => ({
            time,
            revision: (previous?.revision ?? 0) + 1,
          }))
        }
        onTogglePlay={() => void audioControlsRef.current?.toggle()}
        onToggleCollapse={() => setTimelineCollapsed((value) => !value)}
        onResizeHeight={setTimelineHeight}
        onZoom={setTimelineZoom}
        onSelectClip={(clip) => setTimelineSelection(clip)}
        onSelectPage={(pageId) => void activatePage(pageId)}
        onAddPage={() => void addEmptyPage()}
        onSplitClip={() => {
          const selected =
            timelineSelection?.kind === 'caption'
              ? reviewDialogues.find(
                  (dialogue) => dialogue.id === timelineSelection.id,
                )
              : reviewDialogues.find(
                  (dialogue) =>
                    audioClock.positionSeconds > dialogue.start + 0.05 &&
                    audioClock.positionSeconds < dialogue.end - 0.05,
                );
          if (!selected) {
            setProjectMessage(
              'Select a caption clip or place the playhead inside one to split it.',
            );
            return;
          }
          const at = audioClock.positionSeconds;
          if (at <= selected.start + 0.05 || at >= selected.end - 0.05) {
            setProjectMessage('Playhead must be inside the caption to split.');
            return;
          }
          window.dispatchEvent(
            new CustomEvent('comic-editor-split-dialogue', {
              detail: {
                id: selected.id,
                at,
                newId: `dialogue:split:${selected.id}:${Date.now()}`,
              },
            }),
          );
          setProjectMessage(
            `Split “${selected.caption.slice(0, 24) || 'caption'}” at ${at.toFixed(2)}s.`,
          );
        }}
      />
    </div>
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

function formatPlaybackTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
