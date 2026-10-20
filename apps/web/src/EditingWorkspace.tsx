import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { SourceImageMetadata } from '@comic-captioner/shared';
import { createImageSpace } from '@comic-captioner/shared';
import type { DialogueMapping } from '@comic-captioner/core';
import { captionRevealAt, normalizeRevealTokens } from '@comic-captioner/core';
import type { ClockSnapshot, Transcript } from '@comic-captioner/audio-engine';
import { emptyEditorHistory, editorReducer } from './editor-model.js';
import type { EditorDocument } from './editor-model.js';
import { requestAssist } from './assist-client.js';
import type { AssistProposal, AssistTask } from './assist-client.js';
import { proposeTranscriptBubbleMappings } from './dialogue-review.js';
import { BubbleGeometryError, unionBubblePolygons } from './bubble-geometry.js';
import { associateOCRLine } from './ocr-association.js';
import {
  buildReviewQueue,
  candidatesFromBubbles,
  candidatesFromMappings,
  candidatesFromObservations,
} from './review-queue.js';
import { mapReviewHotkey, type ReviewAction } from './review-hotkeys.js';
import { describeBubbleConfidence } from './engine-adapters.js';
import { WorkspaceInspectorPortal } from './WorkspaceInspectorSlot.js';

interface AssetView {
  readonly metadata: SourceImageMetadata;
  readonly src: string;
}
interface Drag {
  readonly x: number;
  readonly y: number;
}

/** Complete single-page editing workspace. Domain entities live only in editorReducer. */
export function EditingWorkspace({
  original,
  cleaned,
  audioClock,
  onAudioToggle,
  onAudioSeek,
  readingOrder = null,
  transcript,
  initialDocument,
  analysis,
  mappingCommand,
  onDocumentChange,
}: {
  readonly original: AssetView | null;
  readonly cleaned: AssetView | null;
  readonly audioName?: string | null;
  readonly audioAsset?: {
    readonly format: string;
    readonly durationSeconds: number;
    readonly sizeBytes: number;
  } | null;
  readonly audioClock?: ClockSnapshot;
  readonly hasTranscript?: boolean;
  readonly liveTranscriptText?: string;
  readonly onAudioToggle?: () => void;
  readonly onAudioSeek?: (timeSeconds: number) => void;
  readonly onAudioImport?: () => void;
  readonly onAutomateSpeech?: () => void;
  readonly speechAutomationBusy?: boolean;
  readonly speechAutomationReady?: boolean;
  readonly readingOrder?: readonly string[] | null;
  readonly transcript?: Transcript | null;
  readonly initialDocument?: EditorDocument | null;
  readonly analysis?: {
    readonly bubbles: readonly {
      readonly id: string;
      readonly kind: 'speech' | 'thought' | 'narration' | 'unknown';
      readonly confidence: number;
      readonly classificationConfidence?: number;
      readonly geometryProvenance?: 'model' | 'derived' | 'hybrid';
      readonly boundingBox?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
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
  } | null;
  readonly mappingCommand?: {
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
  } | null;
  readonly onDocumentChange?: (document: EditorDocument | null) => void;
}) {
  const image = original ?? cleaned;
  const imageId = image?.metadata.id;
  const imageWidth = image?.metadata.dimensions.width;
  const imageHeight = image?.metadata.dimensions.height;
  const [history, dispatch] = useReducer(editorReducer, emptyEditorHistory);
  useEffect(() => {
    const onUndo = () => dispatch({ type: 'undo' });
    const onRedo = () => dispatch({ type: 'redo' });
    window.addEventListener('comic-editor-undo', onUndo);
    window.addEventListener('comic-editor-redo', onRedo);
    return () => {
      window.removeEventListener('comic-editor-undo', onUndo);
      window.removeEventListener('comic-editor-redo', onRedo);
    };
  }, [dispatch]);

  // Publish history depth and stack previews for the toolbar badges.
  useEffect(() => {
    const summarize = (document: EditorDocument | null) => {
      if (!document) return 'Empty';
      const dialogues = Object.values(document.dialogues);
      if (dialogues.length === 0) {
        const bubbles = Object.values(document.bubbles);
        return bubbles.length
          ? `${bubbles.length} bubble${bubbles.length === 1 ? '' : 's'}`
          : 'Empty';
      }
      const last = dialogues[dialogues.length - 1]!;
      return last.caption.slice(0, 28) || 'Caption';
    };
    window.dispatchEvent(
      new CustomEvent('comic-editor-history', {
        detail: {
          canUndo: history.past.length > 0,
          canRedo: history.future.length > 0,
          undoDepth: history.past.length,
          redoDepth: history.future.length,
          undoPreview: history.past
            .slice(-5)
            .map((document) => summarize(document))
            .reverse(),
          redoPreview: history.future.slice(0, 5).map((document) => summarize(document)),
        },
      }),
    );
  }, [history]);

  // Accept inspector edits for the selected caption/bubble geometry.
  useEffect(() => {
    const onCaptionText = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; text: string }>).detail;
      if (!detail?.id) return;
      dispatch({
        type: 'edit-dialogue',
        dialogueId: detail.id,
        patch: { caption: detail.text },
        coalesce: { key: `caption:${detail.id}`, atMs: Date.now() },
      });
    };
    const onCaptionFont = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          id: string;
          fontSizePx?: number;
          fontFamily?: string;
        }>
      ).detail;
      if (!detail?.id) return;
      dispatch({
        type: 'edit-dialogue',
        dialogueId: detail.id,
        patch: {
          ...(detail.fontSizePx != null ? { fontSizePx: detail.fontSizePx } : {}),
          ...(detail.fontFamily ? { fontFamily: detail.fontFamily } : {}),
        },
      });
    };
    const onCaptionTime = (event: Event) => {
      const detail = (
        event as CustomEvent<{ id: string; start: number; end: number }>
      ).detail;
      if (!detail?.id) return;
      dispatch({
        type: 'edit-dialogue',
        dialogueId: detail.id,
        patch: { start: detail.start, end: detail.end },
      });
    };
    const onBubbleGeometry = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          id: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          kind?: string;
        }>
      ).detail;
      if (!detail?.id) return;
      dispatch({
        type: 'edit-bubble',
        bubbleId: detail.id,
        patch: {
          ...(detail.x != null ? { x: detail.x } : {}),
          ...(detail.y != null ? { y: detail.y } : {}),
          ...(detail.width != null ? { width: detail.width } : {}),
          ...(detail.height != null ? { height: detail.height } : {}),
          ...(detail.kind
            ? { kind: detail.kind as 'speech' | 'thought' | 'narration' | 'unknown' }
            : {}),
        },
      });
    };
    const onSplitDialogue = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          id: string;
          at: number;
          newId: string;
        }>
      ).detail;
      if (!detail?.id || !detail.newId) return;
      dispatch({
        type: 'split-dialogue',
        dialogueId: detail.id,
        atSeconds: detail.at,
        newDialogueId: detail.newId,
      });
    };
    window.addEventListener('comic-editor-caption-text', onCaptionText);
    window.addEventListener('comic-editor-caption-font', onCaptionFont);
    window.addEventListener('comic-editor-caption-time', onCaptionTime);
    window.addEventListener('comic-editor-bubble-geometry', onBubbleGeometry);
    window.addEventListener('comic-editor-split-dialogue', onSplitDialogue);
    return () => {
      window.removeEventListener('comic-editor-caption-text', onCaptionText);
      window.removeEventListener('comic-editor-caption-font', onCaptionFont);
      window.removeEventListener('comic-editor-caption-time', onCaptionTime);
      window.removeEventListener('comic-editor-bubble-geometry', onBubbleGeometry);
      window.removeEventListener('comic-editor-split-dialogue', onSplitDialogue);
    };
  }, [dispatch]);
  const [proposal, setProposal] = useState<AssistProposal | null>(null);
  const [mappingProposals, setMappingProposals] = useState<
    readonly DialogueMapping[]
  >([]);
  const [assistTask, setAssistTask] = useState<AssistTask>('ocr-correction');
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [selectedBubbleId, setSelectedBubbleId] = useState<string | null>(null);
  const [selectedBubbleIds, setSelectedBubbleIds] = useState<string[]>([]);
  const [selectedLooseOcrId, setSelectedLooseOcrId] = useState<string | null>(
    null,
  );
  const [reviewCursor, setReviewCursor] = useState(0);
  const [bubbleEditError, setBubbleEditError] = useState<string | null>(null);
  const [showDetection, setShowDetection] = useState(true);
  const [canvasMode, setCanvasMode] = useState<'select' | 'bubble'>('select');
  const [liveCaptions, setLiveCaptions] = useState(true);
  const [selectedDialogueId, setSelectedDialogueId] = useState<string | null>(
    null,
  );
  const [drawing, setDrawing] = useState<Drag | null>(null);
  const [dragEnd, setDragEnd] = useState<Drag | null>(null);
  const [movingDialogueId, setMovingDialogueId] = useState<string | null>(null);

  // Publish selection so the right inspector can show the active object.
  useEffect(() => {
    const bubble = selectedBubbleId
      ? history.present?.bubbles[selectedBubbleId]
      : undefined;
    const dialogue = selectedDialogueId
      ? history.present?.dialogues[selectedDialogueId]
      : selectedBubbleId
        ? history.present?.dialogues[`dialogue:${selectedBubbleId}`]
        : undefined;
    window.dispatchEvent(
      new CustomEvent('comic-editor-selection', {
        detail: {
          kind: bubble ? 'bubble' : dialogue ? 'caption' : 'none',
          bubbleId: selectedBubbleId,
          dialogueId:
            selectedDialogueId ??
            (selectedBubbleId ? `dialogue:${selectedBubbleId}` : null),
          bubble: bubble
            ? {
                id: bubble.id,
                kind: bubble.kind,
                confidence: bubble.confidence ?? null,
                boundingBox: bubble.boundingBox,
              }
            : null,
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
  }, [history.present, selectedBubbleId, selectedDialogueId]);

  const svgRef = useRef<SVGSVGElement>(null);
  const appliedMappingRevision = useRef<number | null>(null);
  const space = useMemo(
    () =>
      imageId && imageWidth && imageHeight
        ? createImageSpace(`workspace:${imageId}`, imageWidth, imageHeight)
        : null,
    [imageId, imageWidth, imageHeight],
  );
  const analysisBubbles = analysis?.bubbles;
  const analysisLines = useMemo(
    () => analysis?.ocr.blocks.flatMap((block) => block.lines),
    [analysis?.ocr],
  );

  useEffect(() => {
    if (space) dispatch({ type: 'initialize', imageSpace: space });
  }, [space]);
  useEffect(() => {
    if (initialDocument && initialDocument.imageSpace.id === space?.id)
      dispatch({ type: 'load-project', document: initialDocument });
  }, [initialDocument, space?.id]);
  useEffect(() => {
    if (!analysisBubbles || !space) return;
    dispatch({
      type: 'import-analysis',
      bubbles: analysisBubbles.map((bubble) => ({
        id: bubble.id,
        kind: bubble.kind,
        confidence: bubble.confidence,
        ...(bubble.classificationConfidence !== undefined
          ? { classificationConfidence: bubble.classificationConfidence }
          : {}),
        ...(bubble.detectionSources
          ? { detectionSources: bubble.detectionSources }
          : {}),
        points: bubble.polygon.points,
        ...(bubble.tail !== undefined ? { tail: bubble.tail } : {}),
      })),
    });
  }, [analysisBubbles, space]);
  useEffect(() => {
    if (!analysisLines || !space) return;
    dispatch({
      type: 'import-ocr',
      lines: analysisLines,
    });
  }, [analysisBubbles, analysisLines, space]);
  const document = history.present;
  useEffect(() => {
    if (
      !mappingCommand ||
      !document ||
      appliedMappingRevision.current === mappingCommand.revision
    )
      return;
    const dialogue = Object.values(document.dialogues).find(
      (item) => item.bubbleId === mappingCommand.bubbleId,
    );
    if (!dialogue) return;
    appliedMappingRevision.current = mappingCommand.revision;
    dispatch({
      type: 'edit-dialogue',
      dialogueId: dialogue.id,
      patch: {
        caption: mappingCommand.caption,
        start: mappingCommand.start,
        end: mappingCommand.end,
        ...(mappingCommand.words ? { words: mappingCommand.words } : {}),
      },
    });
  }, [document, mappingCommand]);
  useEffect(() => {
    onDocumentChange?.(document);
  }, [document, onDocumentChange]);
  const selectedDialogue = selectedDialogueId
    ? document?.dialogues[selectedDialogueId]
    : undefined;
  const selectedBubble = selectedBubbleId
    ? document?.bubbles[selectedBubbleId]
    : undefined;
  const selectedOcr = selectedBubbleId
    ? document?.observations[`ocr:${selectedBubbleId}`]
    : undefined;
  const looseOCR = Object.values(document?.observations ?? {}).filter(
    (observation) =>
      observation.associatedBubbleId === null &&
      observation.classification !== undefined,
  );
  const selectedLooseOCR = looseOCR.find(
    (observation) => observation.id === selectedLooseOcrId,
  );
  const readingOrderBubbles = Object.values(document?.bubbles ?? {}).sort(
    (left, right) =>
      Math.abs(left.boundingBox.y - right.boundingBox.y) >
      Math.min(left.boundingBox.height, right.boundingBox.height) * 0.5
        ? left.boundingBox.y - right.boundingBox.y
        : left.boundingBox.x - right.boundingBox.x,
  );
  const timelineEnd = Math.max(
    10,
    audioClock?.durationSeconds ?? 0,
    ...Object.values(document?.dialogues ?? {}).map((dialogue) => dialogue.end),
  );

  // Confidence-sorted review queue: only uncertain items need attention.
  const reviewQueue = useMemo(() => {
    if (!document) return null;
    const observations = Object.values(document.observations ?? {});
    const bubbles = Object.values(document.bubbles ?? {});
    const mappings =
      mappingProposals.length > 0
        ? mappingProposals
        : proposeTranscriptBubbleMappings(
            document,
            transcript ?? null,
            readingOrder,
          );
    return buildReviewQueue(
      [
        ...candidatesFromObservations(observations),
        ...candidatesFromBubbles(
          bubbles.map((bubble) => ({
            id: bubble.id,
            kind: bubble.kind,
            ...(bubble.confidence !== undefined
              ? { confidence: bubble.confidence }
              : {}),
            ...(bubble.classificationConfidence !== undefined
              ? { classificationConfidence: bubble.classificationConfidence }
              : {}),
            ...(bubble.reviewStatus ? { reviewStatus: bubble.reviewStatus } : {}),
          })),
        ),
        ...candidatesFromMappings(mappings),
      ],
      { confidenceThreshold: 0.85, maxItems: 40 },
    );
  }, [document, mappingProposals, transcript, readingOrder]);

  useEffect(() => {
    function handleEditorShortcut(event: KeyboardEvent) {
      const target = event.target;
      const isEditingText =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      const action = mapReviewHotkey({
        key: event.key,
        ...(event.code ? { code: event.code } : {}),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isEditingText,
      });
      if (!action) return;

      const applyReviewAction = (reviewAction: ReviewAction) => {
        switch (reviewAction.type) {
          case 'undo':
            event.preventDefault();
            dispatch({ type: 'undo' });
            break;
          case 'redo':
            event.preventDefault();
            dispatch({ type: 'redo' });
            break;
          case 'toggle-play':
            event.preventDefault();
            onAudioToggle?.();
            break;
          case 'seek-back':
            event.preventDefault();
            onAudioSeek?.(
              Math.max(0, (audioClock?.positionSeconds ?? 0) - 1 / 30),
            );
            break;
          case 'seek-forward':
            event.preventDefault();
            onAudioSeek?.(
              Math.min(timelineEnd, (audioClock?.positionSeconds ?? 0) + 1 / 30),
            );
            break;
          case 'seek-start':
            event.preventDefault();
            onAudioSeek?.(0);
            break;
          case 'seek-end':
            event.preventDefault();
            onAudioSeek?.(audioClock?.durationSeconds ?? timelineEnd);
            break;
          case 'mode-select':
            setCanvasMode('select');
            break;
          case 'mode-bubble':
            setCanvasMode('bubble');
            break;
          case 'next':
          case 'previous':
          case 'accept':
          case 'reject':
          case 'edit':
          case 'select-alternative': {
            event.preventDefault();
            const items = reviewQueue?.items ?? [];
            if (!items.length) return;
            if (reviewAction.type === 'next') {
              setReviewCursor((index) =>
                Math.min(items.length - 1, index + 1),
              );
              return;
            }
            if (reviewAction.type === 'previous') {
              setReviewCursor((index) => Math.max(0, index - 1));
              return;
            }
            const item = items[Math.min(reviewCursor, items.length - 1)];
            if (!item) return;
            if (item.kind === 'bubble' && item.targetId) {
              setSelectedBubbleId(item.targetId);
            } else if (item.bubbleId) {
              setSelectedBubbleId(String(item.bubbleId));
            }
            if (reviewAction.type === 'accept') {
              if (item.kind === 'bubble') {
                dispatch({
                  type: 'review-bubble',
                  bubbleId: item.targetId,
                  reviewStatus: 'accepted',
                });
              } else if (item.kind === 'ocr-line') {
                dispatch({
                  type: 'review-ocr-observation',
                  observationId: item.targetId,
                  classification: 'dialogue',
                  reviewStatus: 'accepted',
                  ...(item.bubbleId
                    ? { bubbleId: String(item.bubbleId) }
                    : {}),
                });
              }
              setReviewCursor((index) =>
                Math.min(items.length - 1, index + 1),
              );
            } else if (reviewAction.type === 'reject') {
              if (item.kind === 'bubble') {
                dispatch({
                  type: 'review-bubble',
                  bubbleId: item.targetId,
                  reviewStatus: 'rejected',
                });
              }
              setReviewCursor((index) =>
                Math.min(items.length - 1, index + 1),
              );
            }
            break;
          }
        }
      };
      applyReviewAction(action);
    }
    window.addEventListener('keydown', handleEditorShortcut);
    return () => window.removeEventListener('keydown', handleEditorShortcut);
  }, [
    audioClock?.positionSeconds,
    audioClock?.durationSeconds,
    onAudioSeek,
    onAudioToggle,
    timelineEnd,
    reviewQueue,
    reviewCursor,
  ]);

  function commit(action: Parameters<typeof dispatch>[0]) {
    dispatch(action);
    setProposal(null);
  }

  function selectBubble(
    event: ReactPointerEvent<SVGPolygonElement>,
    bubbleId: string,
  ) {
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (additive) {
      setSelectedBubbleIds((selected) =>
        selected.includes(bubbleId)
          ? selected.filter((id) => id !== bubbleId)
          : [...selected, bubbleId],
      );
    } else {
      setSelectedBubbleIds([bubbleId]);
    }
    setSelectedBubbleId(bubbleId);
    setSelectedDialogueId(`dialogue:${bubbleId}`);
    setBubbleEditError(null);
  }

  function mergeSelectedBubbles() {
    if (!document) return;
    const ids = selectedBubbleIds.filter((id) => document.bubbles[id]);
    if (ids.length < 2) return;
    try {
      unionBubblePolygons(ids.map((id) => document.bubbles[id]!.polygon));
      const primary = ids.sort(
        (left, right) =>
          document.order.indexOf(`dialogue:${left}`) -
          document.order.indexOf(`dialogue:${right}`),
      )[0]!;
      commit({ type: 'merge-bubbles', bubbleIds: ids });
      setSelectedBubbleId(primary);
      setSelectedBubbleIds([primary]);
      setSelectedDialogueId(`dialogue:${primary}`);
      setBubbleEditError(null);
    } catch (cause) {
      setBubbleEditError(
        cause instanceof BubbleGeometryError
          ? cause.message
          : 'The selected bubble regions could not be merged.',
      );
    }
  }

  function splitSelectedBubble() {
    if (!selectedBubbleId || selectedBubbleIds.length > 1) return;
    const secondBubbleId = `bubble-${crypto.randomUUID()}`;
    commit({
      type: 'split-bubble',
      bubbleId: selectedBubbleId,
      secondBubbleId,
    });
    setSelectedBubbleIds([selectedBubbleId, secondBubbleId]);
    setBubbleEditError(null);
  }

  async function askGemini() {
    if (!selectedBubble || !selectedDialogue || !selectedOcr) return;
    setAssistBusy(true);
    setAssistError(null);
    setProposal(null);
    const context: Record<string, unknown> = {
      bubble: {
        id: selectedBubble.id,
        kind: selectedBubble.kind,
        bounds: selectedBubble.boundingBox,
      },
      ocrText: selectedOcr.text,
      caption: selectedDialogue.caption,
      candidateBubbleIds: Object.keys(document?.bubbles ?? {}),
      speakerId: selectedDialogue.speakerId,
    };
    try {
      const result = await requestAssist({
        task: assistTask,
        targetId: selectedDialogue.id,
        context,
      });
      setProposal(result);
    } catch (cause) {
      setAssistError(
        cause instanceof Error ? cause.message : 'Gemini Assist failed.',
      );
    } finally {
      setAssistBusy(false);
    }
  }

  function approveProposal() {
    if (
      !proposal ||
      !selectedBubble ||
      !selectedDialogue ||
      proposal.targetId !== selectedDialogue.id
    )
      return;
    if (proposal.task === 'ocr-correction' && 'text' in proposal.suggestion)
      commit({
        type: 'edit-ocr',
        bubbleId: selectedBubble.id,
        text: proposal.suggestion.text,
      });
    else if (
      proposal.task === 'bubble-classification' &&
      'classification' in proposal.suggestion
    )
      commit({
        type: 'edit-bubble',
        bubbleId: selectedBubble.id,
        patch: { kind: proposal.suggestion.classification },
      });
    else if (
      proposal.task === 'dialogue-mapping' &&
      'bubbleId' in proposal.suggestion
    ) {
      const mappedBubble = document?.bubbles[proposal.suggestion.bubbleId];
      if (!mappedBubble) return;
      commit({
        type: 'edit-dialogue',
        dialogueId: selectedDialogue.id,
        patch: {
          bubbleId: mappedBubble.id as typeof selectedDialogue.bubbleId,
        },
      });
      setSelectedBubbleId(mappedBubble.id);
    } else if (
      proposal.task === 'speaker-context' &&
      'speakerId' in proposal.suggestion
    )
      commit({
        type: 'edit-dialogue',
        dialogueId: selectedDialogue.id,
        patch: {
          speakerId: proposal.suggestion.speakerId,
          contextNote: proposal.suggestion.context,
        },
      });
  }

  function proposeTranscriptMappings() {
    if (!document || !transcript) return;
    setMappingProposals(
      proposeTranscriptBubbleMappings(document, transcript, readingOrder),
    );
  }

  // Shell tool drawer can request dialogue match suggestions.
  useEffect(() => {
    const onSuggest = () => proposeTranscriptMappings();
    window.addEventListener('comic-editor-suggest-matches', onSuggest);
    return () =>
      window.removeEventListener('comic-editor-suggest-matches', onSuggest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, transcript, readingOrder]);

  function approveMapping(mapping: DialogueMapping) {
    if (!document || !transcript || !mapping.bubbleId) return;
    const segment = transcript.segments.find(
      (candidate) => candidate.id === mapping.transcriptSegmentId,
    );
    const dialogue = Object.values(document.dialogues).find(
      (candidate) => candidate.bubbleId === mapping.bubbleId,
    );
    if (!segment || !dialogue) return;
    commit({
      type: 'edit-dialogue',
      dialogueId: dialogue.id,
      patch: {
        caption: segment.text,
        start: segment.interval.start.value,
        end: segment.interval.end.value,
        words: segment.words.map((word) => ({
          text: word.text,
          start: word.start.value,
          end: word.end.value,
        })),
      },
    });
    setMappingProposals((previous) =>
      previous.filter((item) => item.id !== mapping.id),
    );
  }

  function pagePoint(event: ReactPointerEvent<SVGElement>): Drag {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x:
        ((event.clientX - bounds.left) * (space?.dimensions.width ?? 1)) /
        bounds.width,
      y:
        ((event.clientY - bounds.top) * (space?.dimensions.height ?? 1)) /
        bounds.height,
    };
  }
  function startDrawing(event: ReactPointerEvent<SVGSVGElement>) {
    if (
      !space ||
      event.target !== event.currentTarget ||
      movingDialogueId ||
      canvasMode !== 'bubble'
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pagePoint(event);
    setDrawing(point);
    setDragEnd(point);
  }
  function moveDrawing(event: ReactPointerEvent<SVGSVGElement>) {
    if (drawing) setDragEnd(pagePoint(event));
  }
  function finishDrawing() {
    if (movingDialogueId && drawing && dragEnd && document) {
      const current = document.dialogues[movingDialogueId];
      if (current) {
        commit({
          type: 'edit-dialogue',
          dialogueId: movingDialogueId,
          patch: {
            position: {
              ...current.position,
              x: current.position.x + dragEnd.x - drawing.x,
              y: current.position.y + dragEnd.y - drawing.y,
            },
          },
        });
      }
      setMovingDialogueId(null);
      setDrawing(null);
      setDragEnd(null);
      return;
    }
    if (!drawing || !dragEnd || !space) return;
    const left = Math.max(0, Math.min(drawing.x, dragEnd.x));
    const top = Math.max(0, Math.min(drawing.y, dragEnd.y));
    const right = Math.min(
      space.dimensions.width,
      Math.max(drawing.x, dragEnd.x),
    );
    const bottom = Math.min(
      space.dimensions.height,
      Math.max(drawing.y, dragEnd.y),
    );
    if (right - left >= 8 && bottom - top >= 8) {
      const id = `bubble-${crypto.randomUUID()}`;
      const polygon = {
        coordinateSpace: space,
        points: [
          { x: left, y: top },
          { x: right, y: top },
          { x: right, y: bottom },
          { x: left, y: bottom },
        ].map((point) => ({ ...point, coordinateSpace: space })),
      };
      commit({ type: 'add-bubble', id, polygon });
      setSelectedBubbleId(id);
      setSelectedBubbleIds([id]);
      setSelectedDialogueId(`dialogue:${id}`);
    }
    setDrawing(null);
    setDragEnd(null);
  }

  if (!image || !space || !document)
    return (
      <section className="p-8 text-center text-stone-600">
        Import an original or cleaned comic page to open the editing workspace.
      </section>
    );
  const rect =
    drawing && dragEnd
      ? {
          x: Math.min(drawing.x, dragEnd.x),
          y: Math.min(drawing.y, dragEnd.y),
          width: Math.abs(dragEnd.x - drawing.x),
          height: Math.abs(dragEnd.y - drawing.y),
        }
      : null;

  const previewTime = audioClock?.positionSeconds ?? 0;
  const activeDialogue = Object.values(document.dialogues).find(
    (dialogue) => previewTime >= dialogue.start && previewTime < dialogue.end,
  );
  const activeWord = activeDialogue
    ? (() => {
        const words = activeDialogue.caption.split(/\s+/).filter(Boolean);
        const span = Math.max(0, activeDialogue.end - activeDialogue.start);
        const slice = span / Math.max(1, words.length);
        const index = Math.floor((previewTime - activeDialogue.start) / slice);
        return words[Math.min(words.length - 1, Math.max(0, index))] ?? null;
      })()
    : null;

  return (
    <main className="comic-editor-workspace comic-canvas-stage">
      <div className="comic-canvas-toolbar" role="toolbar" aria-label="Canvas tools">
        <button
          type="button"
          className={`canvas-mode-button ${canvasMode === 'select' ? 'is-active' : ''}`}
          aria-pressed={canvasMode === 'select'}
          onClick={() => setCanvasMode('select')}
          title="Select and move objects · V"
        >
          Select
        </button>
        <button
          type="button"
          className={`canvas-mode-button ${canvasMode === 'bubble' ? 'is-active' : ''}`}
          aria-pressed={canvasMode === 'bubble'}
          onClick={() => setCanvasMode('bubble')}
          title="Draw bubble · B"
        >
          + Bubble
        </button>
        <button
          className="canvas-mode-button"
          aria-pressed={showDetection}
          onClick={() => setShowDetection((visible) => !visible)}
          type="button"
        >
          {showDetection ? 'Hide detections' : 'Show detections'}
        </button>
        <button
          className="canvas-mode-button"
          aria-pressed={liveCaptions}
          onClick={() => setLiveCaptions((on) => !on)}
          type="button"
          title="Preview live word-by-word captions synced to the audio clock"
        >
          {liveCaptions ? 'Live captions: on' : 'Live captions: off'}
        </button>
        <button
          className="canvas-mode-button"
          disabled={selectedBubbleIds.length < 2}
          onClick={mergeSelectedBubbles}
          type="button"
        >
          Merge {selectedBubbleIds.length > 1 ? selectedBubbleIds.length : ''}
        </button>
        <button
          className="canvas-mode-button"
          disabled={selectedBubbleIds.length !== 1}
          onClick={splitSelectedBubble}
          type="button"
        >
          Split at center
        </button>
        {transcript && (
          <button
            className="canvas-mode-button"
            onClick={proposeTranscriptMappings}
            type="button"
            title="Suggest transcript-to-bubble dialogue matches"
          >
            Suggest matches
          </button>
        )}
        <span className="canvas-toolbar-meta">
          {space.dimensions.width} × {space.dimensions.height} · ImageSpace
        </span>
      </div>
      {reviewQueue && reviewQueue.items.length > 0 && (
        <section
          aria-label="Confidence-sorted review queue"
          className="canvas-review-strip"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
            <span>
              Review queue · {reviewQueue.summary.queued} uncertain item
              {reviewQueue.summary.queued === 1 ? '' : 's'}
            </span>
            <span className="font-normal text-indigo-800">
              {reviewQueue.summary.critical} critical ·{' '}
              {reviewQueue.summary.high} high · {reviewQueue.summary.normal}{' '}
              normal · avg{' '}
              {Math.round(reviewQueue.summary.averageQueuedConfidence * 100)}%
            </span>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {reviewQueue.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-start gap-2 rounded border border-indigo-100 bg-white px-2 py-1 text-left text-xs hover:border-indigo-300"
                onClick={() => {
                  if (item.kind === 'bubble' && item.targetId) {
                    setSelectedBubbleId(item.targetId);
                  } else if (item.kind === 'ocr-line' && item.bubbleId) {
                    setSelectedBubbleId(String(item.bubbleId));
                  }
                }}
              >
                <span
                  className={
                    item.priority === 'critical'
                      ? 'font-semibold text-red-700'
                      : item.priority === 'high'
                        ? 'font-semibold text-amber-700'
                        : 'text-stone-600'
                  }
                >
                  {Math.round(item.confidence * 100)}%
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{item.label}</span>
                  {item.detail ? (
                    <span className="block truncate text-stone-600">
                      {item.detail}
                    </span>
                  ) : null}
                  <span className="block text-stone-500">{item.reason}</span>
                </span>
                {item.suggestedFix ? (
                  <span className="shrink-0 text-indigo-700">
                    {item.suggestedFix}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      )}
      {mappingProposals.length > 0 && (
        <section
          aria-label="Dialogue match proposals"
          className="canvas-review-strip is-mapping"
        >
          <div className="mb-2 text-sm font-semibold">
            Dialogue matches · review each suggestion
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {mappingProposals.map((mapping) => {
              const segment = transcript?.segments.find(
                (item) => item.id === mapping.transcriptSegmentId,
              );
              return (
                <div
                  className="rounded border border-amber-200 bg-white p-2 text-xs"
                  key={mapping.id}
                >
                  <div className="font-medium">
                    {segment?.text || 'Transcript segment'} →{' '}
                    {mapping.bubbleId ?? 'No confident match'}
                  </div>
                  <div className="my-1 text-stone-600">
                    {Math.round(mapping.confidence * 100)}% confidence ·{' '}
                    {mapping.reviewFlag.replace('-', ' ')}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="rounded bg-emerald-700 px-2 py-1 text-white disabled:opacity-40"
                      disabled={!mapping.bubbleId}
                      onClick={() => approveMapping(mapping)}
                      type="button"
                    >
                      Approve text + timing
                    </button>
                    <button
                      className="rounded border px-2 py-1"
                      onClick={() =>
                        setMappingProposals((items) =>
                          items.filter((item) => item.id !== mapping.id),
                        )
                      }
                      type="button"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <section
        aria-label="Comic canvas"
        id="comic-preview"
        className="comic-preview-panel"
      >
        <div className="relative mx-auto w-fit max-w-full">
            <img
              className="block max-h-[62vh] max-w-full select-none object-contain"
              src={image.src}
              alt="Comic page canvas"
              draggable={false}
            />
            <svg
              ref={svgRef}
              className="absolute inset-0 h-full w-full touch-none"
              viewBox={`0 0 ${space.dimensions.width} ${space.dimensions.height}`}
              preserveAspectRatio="none"
              onPointerDown={startDrawing}
              onPointerMove={moveDrawing}
              onPointerUp={finishDrawing}
              onPointerCancel={() => {
                setDrawing(null);
                setDragEnd(null);
              }}
            >
              {Object.values(document.bubbles).map((bubble) => (
                <g key={bubble.id}>
                  <polygon
                    points={bubble.polygon.points
                      .map((point) => `${point.x},${point.y}`)
                      .join(' ')}
                    fill={
                      !showDetection
                        ? 'transparent'
                        : selectedBubbleIds.includes(bubble.id)
                          ? 'rgba(79,70,229,.14)'
                          : bubble.reviewStatus === 'rejected'
                            ? 'rgba(239,68,68,.08)'
                            : bubble.reviewStatus === 'accepted'
                              ? 'rgba(16,185,129,.1)'
                              : 'rgba(245,158,11,.08)'
                    }
                    stroke={
                      showDetection
                        ? selectedBubbleIds.includes(bubble.id)
                          ? '#4f46e5'
                          : bubble.reviewStatus === 'rejected'
                            ? '#ef4444'
                            : bubble.reviewStatus === 'accepted'
                              ? '#059669'
                              : '#d97706'
                        : 'transparent'
                    }
                    strokeWidth={
                      showDetection
                        ? Math.max(space.dimensions.width / 600, 2)
                        : 0
                    }
                    vectorEffect="non-scaling-stroke"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      selectBubble(event, bubble.id);
                    }}
                  />
                  <title>{bubble.kind} bubble</title>
                </g>
              ))}
              {showDetection &&
                analysis?.textRegions?.map((region) => {
                  const uncertain =
                    region.needsReview ||
                    region.associationClassification === 'ambiguous' ||
                    !region.associatedBubbleId;
                  return (
                    <g key={`text-region:${region.id}`} pointerEvents="none">
                      <rect
                        x={region.boundingBox.x}
                        y={region.boundingBox.y}
                        width={region.boundingBox.width}
                        height={region.boundingBox.height}
                        fill={
                          uncertain
                            ? 'rgba(239,68,68,.08)'
                            : 'rgba(14,165,233,.1)'
                        }
                        stroke={uncertain ? '#dc2626' : '#0284c7'}
                        strokeWidth={Math.max(space.dimensions.width / 800, 1.5)}
                        strokeDasharray={uncertain ? '4 3' : undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                      <title>
                        {`Text region ${region.id} · det ${Math.round(region.confidence * 100)}% · assoc ${Math.round((region.associationConfidence ?? 0) * 100)}% · ${region.associationClassification ?? 'non-dialogue'}${region.associatedBubbleId ? ` → ${region.associatedBubbleId}` : ''}`}
                      </title>
                      <text
                        x={region.boundingBox.x}
                        y={region.boundingBox.y + region.boundingBox.height + 12}
                        fill={uncertain ? '#b91c1c' : '#075985'}
                        fontSize={Math.max(space.dimensions.width / 140, 9)}
                        stroke="white"
                        strokeWidth={Math.max(space.dimensions.width / 700, 1)}
                        paintOrder="stroke"
                      >
                        {`det ${Math.round(region.confidence * 100)}% · assoc ${Math.round((region.associationConfidence ?? 0) * 100)}%`}
                      </text>
                    </g>
                  );
                })}
              {showDetection &&
                analysis?.ocr.blocks
                  .flatMap((block) => block.lines)
                  .map((line, index) => (
                    <g
                      key={line.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Select OCR text: ${line.text}`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        const match = associateOCRLine(
                          line.boundingBox,
                          Object.values(document.bubbles),
                        );
                        if (match.bubbleId) {
                          setSelectedBubbleId(match.bubbleId);
                          setSelectedBubbleIds([match.bubbleId]);
                          setSelectedLooseOcrId(null);
                        } else {
                          setSelectedLooseOcrId(`ocr:${line.id}`);
                        }
                      }}
                    >
                      <rect
                        x={line.boundingBox.x}
                        y={line.boundingBox.y}
                        width={line.boundingBox.width}
                        height={line.boundingBox.height}
                        fill="rgba(245,158,11,.08)"
                        stroke="#d97706"
                        strokeWidth={Math.max(space.dimensions.width / 1000, 1)}
                        vectorEffect="non-scaling-stroke"
                      />
                      <title>
                        {`Reading order ${index + 1}: ${line.text} · ${Math.round(line.confidence * 100)}% confidence`}
                      </title>
                      <text
                        x={line.boundingBox.x}
                        y={Math.max(10, line.boundingBox.y - 3)}
                        fill="#92400e"
                        fontSize={Math.max(space.dimensions.width / 110, 10)}
                        stroke="white"
                        strokeWidth={Math.max(space.dimensions.width / 600, 1)}
                        paintOrder="stroke"
                      >
                        {`${index + 1} · ${Math.round(line.confidence * 100)}%`}
                      </text>
                    </g>
                  ))}
              {showDetection &&
                readingOrderBubbles.map((bubble, index) => {
                  const centerX =
                    bubble.boundingBox.x + bubble.boundingBox.width / 2;
                  const centerY =
                    bubble.boundingBox.y + bubble.boundingBox.height / 2;
                  return (
                    <g key={`order:${bubble.id}`} pointerEvents="none">
                      <circle
                        cx={centerX}
                        cy={centerY}
                        r={Math.max(space.dimensions.width / 90, 12)}
                        fill="#312e81"
                      />
                      <text
                        x={centerX}
                        y={centerY}
                        fill="white"
                        fontSize={Math.max(space.dimensions.width / 120, 14)}
                        textAnchor="middle"
                        dominantBaseline="central"
                      >
                        {index + 1}
                      </text>
                    </g>
                  );
                })}
              {Object.values(document.dialogues).map((dialogue) => {
                const words = dialogue.caption.split(/\s+/).filter(Boolean);
                const providedWords =
                  dialogue.words && dialogue.words.length === words.length
                    ? dialogue.words.map((word) => ({
                        text: word.text,
                        startSeconds: word.start,
                        endSeconds: word.end,
                      }))
                    : transcript?.segments
                        .find((item) => item.id === dialogue.id)
                        ?.words.map((word) => ({
                          text: word.text,
                          startSeconds: word.start.value,
                          endSeconds: word.end.value,
                        }));
                const tokens = normalizeRevealTokens(
                  providedWords,
                  dialogue.caption,
                  dialogue.start,
                  dialogue.end,
                );
                const reveal = liveCaptions
                  ? captionRevealAt(tokens, previewTime, {
                      mode: 'word-by-word',
                    })
                  : null;
                if (liveCaptions && !reveal?.started) return null;
                return (
                <g key={dialogue.id}>
                  {dialogue.id === selectedDialogueId && (
                    <rect
                      x={
                        dialogue.position.x -
                        Math.max(
                          dialogue.caption.length * dialogue.fontSizePx * 0.32,
                          18,
                        )
                      }
                      y={dialogue.position.y - dialogue.fontSizePx}
                      width={Math.max(
                        dialogue.caption.length * dialogue.fontSizePx * 0.64,
                        36,
                      )}
                      height={dialogue.fontSizePx * 1.35}
                      fill="none"
                      stroke="#a8d75a"
                      strokeDasharray="5 3"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  )}
                  <text
                    x={dialogue.position.x}
                    y={dialogue.position.y}
                    fontFamily={dialogue.fontFamily}
                    fontSize={dialogue.fontSizePx}
                    fill="#171717"
                    textAnchor="middle"
                    pointerEvents="all"
                    className="comic-caption-object"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      const start = pagePoint(event);
                      svgRef.current?.setPointerCapture(event.pointerId);
                      setSelectedDialogueId(dialogue.id);
                      setSelectedBubbleId(dialogue.bubbleId);
                      setMovingDialogueId(dialogue.id);
                      setDrawing(start);
                      setDragEnd(start);
                    }}
                  >
                    {liveCaptions
                      ? words.map((word, index) => {
                          const state = reveal?.tokens[index];
                          return (
                            <tspan
                              key={index}
                              fillOpacity={state?.revealed ? 1 : 0}
                              fill={state?.active ? '#7c3aed' : undefined}
                            >
                              {word}
                              {index < words.length - 1 ? ' ' : ''}
                            </tspan>
                          );
                        })
                      : dialogue.caption}
                    <title>Drag to move caption · select to edit</title>
                  </text>
                </g>
                );
              })}
              {rect && (
                <rect
                  {...rect}
                  fill="rgba(79,70,229,.12)"
                  stroke="#4f46e5"
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
            </svg>
            {liveCaptions && (
              <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 font-mono text-xs text-white">
                {`t=${previewTime.toFixed(2)}s · ${
                  activeDialogue ? `bubble ${activeDialogue.bubbleId}` : '—'
                } · ${activeWord ? `word "${activeWord}"` : '—'}`}
              </div>
            )}
          </div>
        </section>
        <WorkspaceInspectorPortal>
          <div className="workspace-review-tools">
            <h3 className="workspace-review-title">Review</h3>
          {analysis?.confidences && (
            <section
              aria-label="Detection confidences"
              className="mb-3 rounded-lg border border-sky-200 bg-sky-50 p-3"
            >
              <h3 className="text-sm font-semibold text-sky-950">
                Detection confidences
              </h3>
              <p className="mt-1 text-[11px] text-sky-900">
                Bubble, text-region, OCR, and association scores stay separate.
              </p>
              <dl className="mt-2 space-y-1 text-xs text-sky-950">
                <div className="flex justify-between gap-2">
                  <dt>Bubble detection</dt>
                  <dd>
                    {Math.round(analysis.confidences.bubbleDetection * 100)}%
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Text regions</dt>
                  <dd>
                    {Math.round(analysis.confidences.textRegionDetection * 100)}%
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>OCR recognition</dt>
                  <dd>
                    {analysis.confidences.ocrRecognition === null
                      ? '—'
                      : `${Math.round(analysis.confidences.ocrRecognition * 100)}%`}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Bubble association</dt>
                  <dd>
                    {analysis.confidences.bubbleAssociation === null
                      ? '—'
                      : `${Math.round(analysis.confidences.bubbleAssociation * 100)}%`}
                  </dd>
                </div>
              </dl>
            </section>
          )}
          {analysis?.textRegions &&
            analysis.textRegions.some(
              (region) =>
                region.needsReview ||
                region.associationClassification === 'ambiguous' ||
                !region.associatedBubbleId,
            ) && (
              <section
                aria-label="Uncertain text regions"
                className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3"
              >
                <h3 className="text-sm font-semibold text-rose-950">
                  Uncertain text regions
                </h3>
                <p className="mt-1 text-[11px] text-rose-900">
                  Low-confidence or unassociated regions stay available for
                  manual review.
                </p>
                <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                  {analysis.textRegions
                    .filter(
                      (region) =>
                        region.needsReview ||
                        region.associationClassification === 'ambiguous' ||
                        !region.associatedBubbleId,
                    )
                    .map((region) => (
                      <li
                        key={region.id}
                        className="rounded border border-rose-200 bg-white px-2 py-1 text-xs"
                      >
                        <span className="block truncate font-medium">
                          {region.id}
                        </span>
                        <span className="text-[10px] text-rose-800">
                          det {Math.round(region.confidence * 100)}% · assoc{' '}
                          {Math.round((region.associationConfidence ?? 0) * 100)}
                          % · {region.associationClassification ?? 'non-dialogue'}
                        </span>
                      </li>
                    ))}
                </ul>
              </section>
            )}
          {looseOCR.length > 0 && (
            <section
              aria-label="Unassociated OCR review"
              className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3"
            >
              <h3 className="text-sm font-semibold text-amber-950">
                Other detected text · {looseOCR.length}
              </h3>
              <p className="mt-1 text-[11px] text-amber-900">
                Text outside a confidently matched bubble is kept for review.
              </p>
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                {looseOCR.map((observation) => (
                  <button
                    key={observation.id}
                    type="button"
                    className={`w-full rounded border px-2 py-1 text-left text-xs ${selectedLooseOcrId === observation.id ? 'border-amber-700 bg-white' : 'border-amber-200 bg-amber-100/60'}`}
                    onClick={() => setSelectedLooseOcrId(observation.id)}
                  >
                    <span className="block truncate">{observation.text}</span>
                    <span className="text-[10px] text-amber-800">
                      {observation.classification} ·{' '}
                      {observation.reviewStatus ?? 'pending-review'}
                    </span>
                  </button>
                ))}
              </div>
              {selectedLooseOCR && (
                <div className="mt-2 space-y-2 border-t border-amber-200 pt-2">
                  <label className="block text-xs font-medium">
                    Correct detected text
                    <textarea
                      aria-label="Unassociated OCR correction"
                      className="editor-input mt-1 min-h-14 w-full"
                      value={selectedLooseOCR.text}
                      onChange={(event) =>
                        commit({
                          type: 'edit-loose-ocr',
                          observationId: selectedLooseOCR.id,
                          text: event.currentTarget.value,
                          coalesce: {
                            key: `loose-ocr:${selectedLooseOCR.id}`,
                            atMs: Date.now(),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="block text-xs">
                    Assign to bubble
                    <select
                      aria-label="Assign OCR text to bubble"
                      className="editor-input mt-1 w-full"
                      value={selectedBubbleId ?? ''}
                      onChange={(event) => {
                        const bubbleId = event.currentTarget.value;
                        if (bubbleId) {
                          setSelectedBubbleId(bubbleId);
                          setSelectedBubbleIds([bubbleId]);
                        }
                      }}
                    >
                      <option value="">Choose a bubble…</option>
                      {Object.values(document?.bubbles ?? {}).map((bubble) => (
                        <option key={bubble.id} value={bubble.id}>
                          {bubble.kind} · {bubble.id.slice(-8)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded bg-indigo-700 px-2 py-1 text-[11px] text-white"
                      disabled={!selectedBubbleId}
                      onClick={() => {
                        commit({
                          type: 'review-ocr-observation',
                          observationId: selectedLooseOCR.id,
                          classification: 'dialogue',
                          reviewStatus: 'accepted',
                          bubbleId: selectedBubbleId!,
                        });
                        setSelectedLooseOcrId(null);
                      }}
                    >
                      Approve as dialogue
                    </button>
                    <button
                      type="button"
                      className="rounded border border-stone-300 bg-white px-2 py-1 text-[11px]"
                      onClick={() => {
                        commit({
                          type: 'review-ocr-observation',
                          observationId: selectedLooseOCR.id,
                          classification: 'non-dialogue',
                          reviewStatus: 'accepted',
                        });
                        setSelectedLooseOcrId(null);
                      }}
                    >
                      Keep as non-dialogue
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
          {selectedBubble && selectedDialogue ? (
            <div className="space-y-3">
              <fieldset className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                <legend className="px-1 text-sm font-semibold text-indigo-900">
                  Gemini Assist
                </legend>
                <label className="block text-xs">
                  Assistance type
                  <select
                    className="editor-input mt-1 w-full"
                    value={assistTask}
                    onChange={(event) => {
                      setAssistTask(event.currentTarget.value as AssistTask);
                      setProposal(null);
                      setAssistError(null);
                    }}
                  >
                    <option value="ocr-correction">Correct OCR</option>
                    <option value="bubble-classification">
                      Classify bubble
                    </option>
                    <option value="dialogue-mapping">
                      Map dialogue to bubble
                    </option>
                    <option value="speaker-context">
                      Analyze speaker/context
                    </option>
                  </select>
                </label>
                <button
                  className="mt-2 w-full rounded-md bg-indigo-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  disabled={assistBusy}
                  onClick={() => void askGemini()}
                >
                  {assistBusy ? 'Analyzing…' : 'Request suggestion'}
                </button>
                {assistError && (
                  <p role="alert" className="mt-2 text-xs text-red-700">
                    {assistError}
                  </p>
                )}
                {proposal && (
                  <div className="mt-3 rounded-md border border-indigo-200 bg-white p-2 text-xs">
                    <div className="font-semibold">
                      Suggestion · {Math.round(proposal.confidence * 100)}%
                      confidence
                    </div>
                    <p className="my-2 break-words">
                      {'text' in proposal.suggestion
                        ? proposal.suggestion.text
                        : 'classification' in proposal.suggestion
                          ? proposal.suggestion.classification
                          : 'bubbleId' in proposal.suggestion
                            ? `Bubble ${proposal.suggestion.bubbleId}`
                            : `${proposal.suggestion.speakerId}: ${proposal.suggestion.context}`}
                    </p>
                    <p className="mb-2 text-stone-500">{proposal.rationale}</p>
                    <div className="flex gap-2">
                      <button
                        className="rounded bg-indigo-700 px-2 py-1 text-white"
                        onClick={approveProposal}
                      >
                        Approve · undoable
                      </button>
                      <button
                        className="rounded border border-stone-300 px-2 py-1"
                        onClick={() => setProposal(null)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-indigo-800">
                  Suggestions stay pending until approved. Approval is added to
                  undo history.
                </p>
              </fieldset>
              <fieldset className="space-y-2 rounded-lg border border-stone-200 p-3">
                <legend className="px-1 text-sm font-medium">
                  Bubble geometry
                </legend>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="capitalize">
                    Review: {selectedBubble.reviewStatus ?? 'pending-review'}
                  </span>
                  <span>
                    {describeBubbleConfidence({
                      ...(selectedBubble.confidence !== undefined
                        ? { confidence: selectedBubble.confidence }
                        : {}),
                      ...(selectedBubble.detectionSources
                        ? { detectionSources: selectedBubble.detectionSources }
                        : {}),
                    })}
                  </span>
                </div>
                {selectedBubble.classificationConfidence !== undefined && (
                  <p className="text-xs text-stone-600">
                    Type confidence:{' '}
                    {Math.round(selectedBubble.classificationConfidence * 100)}%
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    className="rounded bg-emerald-700 px-2 py-1 text-xs text-white"
                    onClick={() =>
                      commit({
                        type: 'review-bubble',
                        bubbleId: selectedBubble.id,
                        reviewStatus: 'accepted',
                      })
                    }
                    type="button"
                  >
                    Accept
                  </button>
                  <button
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700"
                    onClick={() =>
                      commit({
                        type: 'review-bubble',
                        bubbleId: selectedBubble.id,
                        reviewStatus: 'rejected',
                      })
                    }
                    type="button"
                  >
                    Reject
                  </button>
                </div>
                {bubbleEditError && (
                  <p className="text-xs text-red-700" role="alert">
                    {bubbleEditError}
                  </p>
                )}
                {(['x', 'y', 'width', 'height'] as const).map((field) => (
                  <label
                    className="flex items-center justify-between gap-2 text-xs capitalize"
                    key={field}
                  >
                    {field}
                    <input
                      className="editor-input w-24"
                      type="number"
                      value={Math.round(
                        field === 'x' || field === 'y'
                          ? selectedBubble.boundingBox[field]
                          : selectedBubble.boundingBox[field],
                      )}
                      onChange={(event) =>
                        commit({
                          type: 'edit-bubble',
                          bubbleId: selectedBubble.id,
                          patch: { [field]: Number(event.currentTarget.value) },
                        })
                      }
                    />
                  </label>
                ))}
                <label className="flex items-center justify-between text-xs">
                  Type
                  <select
                    className="editor-input"
                    value={selectedBubble.kind}
                    onChange={(event) =>
                      commit({
                        type: 'edit-bubble',
                        bubbleId: selectedBubble.id,
                        patch: {
                          kind: event.currentTarget.value as
                            'speech' | 'thought' | 'narration' | 'unknown',
                        },
                      })
                    }
                  >
                    {['speech', 'thought', 'narration', 'unknown'].map(
                      (kind) => (
                        <option key={kind}>{kind}</option>
                      ),
                    )}
                  </select>
                </label>
                <button
                  className="text-xs text-red-700"
                  onClick={() => {
                    commit({
                      type: 'delete-bubble',
                      bubbleId: selectedBubble.id,
                    });
                    setSelectedBubbleId(null);
                    setSelectedBubbleIds((ids) =>
                      ids.filter((id) => id !== selectedBubble.id),
                    );
                    setSelectedDialogueId(null);
                  }}
                >
                  Delete bubble
                </button>
              </fieldset>
              <label className="block text-xs font-medium">
                Original OCR
                {selectedOcr?.classification && (
                  <span className="ml-2 font-normal text-stone-500">
                    {selectedOcr.classification} ·{' '}
                    {selectedOcr.reviewStatus ?? 'pending-review'}
                  </span>
                )}
                <textarea
                  aria-label="OCR text"
                  className="editor-input mt-1 min-h-16 w-full"
                  value={selectedOcr?.text ?? ''}
                  onChange={(event) =>
                    commit({
                      type: 'edit-ocr',
                      bubbleId: selectedBubble.id,
                      text: event.currentTarget.value,
                      coalesce: {
                        key: `ocr:${selectedBubble.id}`,
                        atMs: Date.now(),
                      },
                    })
                  }
                />
              </label>
              {selectedOcr?.text && selectedOcr.reviewStatus !== 'accepted' && (
                <button
                  type="button"
                  className="w-full rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white"
                  onClick={() =>
                    commit({
                      type: 'review-ocr-observation',
                      observationId: selectedOcr.id,
                      classification: 'dialogue',
                      reviewStatus: 'accepted',
                      bubbleId: selectedBubble.id,
                    })
                  }
                >
                  Approve OCR text for caption
                </button>
              )}
              <label className="block text-xs font-medium">
                Caption
                <textarea
                  aria-label="Caption text"
                  className="editor-input mt-1 min-h-20 w-full"
                  value={selectedDialogue.caption}
                  onChange={(event) =>
                    commit({
                      type: 'edit-dialogue',
                      dialogueId: selectedDialogue.id,
                      patch: { caption: event.currentTarget.value },
                      coalesce: {
                        key: `caption:${selectedDialogue.id}`,
                        atMs: Date.now(),
                      },
                    })
                  }
                />
              </label>
              <label className="block text-xs">
                Font family
                <input
                  aria-label="Font family"
                  className="editor-input mt-1 w-full"
                  value={selectedDialogue.fontFamily}
                  onChange={(event) =>
                    commit({
                      type: 'edit-dialogue',
                      dialogueId: selectedDialogue.id,
                      patch: { fontFamily: event.currentTarget.value },
                    })
                  }
                />
              </label>
              <label className="block text-xs">
                Speaker ID
                <input
                  aria-label="Speaker ID"
                  className="editor-input mt-1 w-full"
                  value={selectedDialogue.speakerId}
                  onChange={(event) =>
                    commit({
                      type: 'edit-dialogue',
                      dialogueId: selectedDialogue.id,
                      patch: { speakerId: event.currentTarget.value },
                    })
                  }
                />
              </label>
              <label className="block text-xs">
                Speaker/context notes
                <textarea
                  aria-label="Speaker context"
                  className="editor-input mt-1 min-h-14 w-full"
                  value={selectedDialogue.contextNote}
                  onChange={(event) =>
                    commit({
                      type: 'edit-dialogue',
                      dialogueId: selectedDialogue.id,
                      patch: { contextNote: event.currentTarget.value },
                    })
                  }
                />
              </label>
              {(
                [
                  ['Font size', 'fontSizePx', 1, 200],
                  ['Line spacing', 'lineSpacingPx', 0, 100],
                  ['Padding', 'paddingPx', 0, 100],
                ] as const
              ).map(([label, field, min, max]) => (
                <label
                  className="flex items-center justify-between text-xs"
                  key={field}
                >
                  {label}
                  <input
                    aria-label={label}
                    className="editor-input w-24"
                    type="number"
                    min={min}
                    max={max}
                    value={selectedDialogue[field]}
                    onChange={(event) =>
                      commit({
                        type: 'edit-dialogue',
                        dialogueId: selectedDialogue.id,
                        patch: { [field]: Number(event.currentTarget.value) },
                      })
                    }
                  />
                </label>
              ))}
              <div className="grid grid-cols-2 gap-2">
                {(['x', 'y'] as const).map((axis) => (
                  <label className="text-xs" key={axis}>
                    Caption {axis.toUpperCase()}
                    <input
                      aria-label={`Caption position ${axis}`}
                      className="editor-input mt-1 w-full"
                      type="number"
                      value={selectedDialogue.position[axis]}
                      onChange={(event) =>
                        commit({
                          type: 'edit-dialogue',
                          dialogueId: selectedDialogue.id,
                          patch: {
                            position: {
                              ...selectedDialogue.position,
                              [axis]: Number(event.currentTarget.value),
                            },
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : selectedBubble ? (
            <p className="text-sm text-stone-500">
              This bubble has no dialogue yet. Accept it in the review queue or
              draw a caption to continue.
            </p>
          ) : (
            <p className="text-sm text-stone-500">
              Select or draw a bubble to edit its dialogue and geometry.
            </p>
          )}
          </div>
        </WorkspaceInspectorPortal>
    </main>
  );
}
