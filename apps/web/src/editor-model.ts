import type { TextObservation } from '@comic-captioner/core';
import type {
  Bounds,
  ImageSpace,
  Point,
  Polygon,
} from '@comic-captioner/shared';
import type { BubbleId } from '@comic-captioner/shared';
import { splitBubblePolygon, unionBubblePolygons } from './bubble-geometry.js';
import {
  pushHistory,
  redoHistory,
  undoHistory,
  type CoalesceHint,
  type HistoryState,
} from './history.js';
import {
  associateOCRLine,
  deduplicateOCRLines,
  groupOCRLines,
} from './ocr-association.js';

export type BubbleKind = 'speech' | 'thought' | 'narration' | 'unknown';
export type BubbleReviewStatus =
  'pending-review' | 'accepted' | 'rejected' | 'edited';
export interface EditableBubble {
  readonly id: string;
  readonly kind: BubbleKind;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly polygon: Polygon<ImageSpace>;
  readonly tail?: Polygon<ImageSpace> | null;
  readonly confidence?: number;
  readonly classificationConfidence?: number;
  readonly source?: 'detected' | 'manual';
  /** Hybrid detector provenance: deterministic geometry and/or proposal providers. */
  readonly detectionSources?: readonly ('detected' | 'ml' | 'heuristic')[];
  readonly reviewStatus?: BubbleReviewStatus;
}

export interface DialogueWordTiming {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface EditableDialogue {
  readonly id: string;
  readonly bubbleId: BubbleId;
  readonly caption: string;
  readonly start: number;
  readonly end: number;
  /** Acoustic word timings for typewriter reveal; omitted → even slices. */
  readonly words?: readonly DialogueWordTiming[];
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly lineSpacingPx: number;
  readonly paddingPx: number;
  readonly position: Point<ImageSpace>;
  readonly speakerId: string;
  readonly contextNote: string;
}

export interface EditorDocument {
  readonly imageSpace: ImageSpace;
  readonly bubbles: Readonly<Record<string, EditableBubble>>;
  readonly observations: Readonly<Record<string, TextObservation>>;
  readonly dialogues: Readonly<Record<string, EditableDialogue>>;
  readonly order: readonly string[];
}

export type EditorHistory = HistoryState<EditorDocument>;

export type EditorAction =
  | { readonly type: 'initialize'; readonly imageSpace: ImageSpace }
  | { readonly type: 'load-project'; readonly document: EditorDocument }
  | {
      readonly type: 'import-analysis';
      readonly bubbles: readonly {
        readonly id: string;
        readonly kind: BubbleKind;
        readonly confidence: number;
        readonly classificationConfidence?: number;
        readonly detectionSources?: readonly (
          | 'detected'
          | 'ml'
          | 'heuristic'
        )[];
        readonly points: readonly { readonly x: number; readonly y: number }[];
        readonly tail?:
          readonly { readonly x: number; readonly y: number }[] | null;
      }[];
    }
  | {
      readonly type: 'import-ocr';
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
    }
  | {
      readonly type: 'add-bubble';
      readonly id: string;
      readonly polygon: Polygon<ImageSpace>;
    }
  | { readonly type: 'delete-bubble'; readonly bubbleId: string }
  | {
      readonly type: 'review-bubble';
      readonly bubbleId: string;
      readonly reviewStatus: Exclude<BubbleReviewStatus, 'edited'>;
    }
  | {
      readonly type: 'merge-bubbles';
      readonly bubbleIds: readonly string[];
    }
  | {
      readonly type: 'split-bubble';
      readonly bubbleId: string;
      readonly secondBubbleId: string;
    }
  | {
      readonly type: 'edit-bubble';
      readonly bubbleId: string;
      readonly patch: {
        readonly kind?: BubbleKind;
        readonly x?: number;
        readonly y?: number;
        readonly width?: number;
        readonly height?: number;
      };
    }
  | {
      readonly type: 'edit-ocr';
      readonly bubbleId: string;
      readonly text: string;
      /** Typing bursts sharing this marker collapse into one undo step. */
      readonly coalesce?: CoalesceHint;
    }
  | {
      readonly type: 'review-ocr-observation';
      readonly observationId: string;
      readonly classification: 'dialogue' | 'non-dialogue' | 'ambiguous';
      readonly reviewStatus: 'accepted' | 'rejected' | 'pending-review';
      readonly bubbleId?: string;
    }
  | {
      readonly type: 'edit-loose-ocr';
      readonly observationId: string;
      readonly text: string;
      readonly coalesce?: CoalesceHint;
    }
  | {
      readonly type: 'edit-dialogue';
      readonly dialogueId: string;
      readonly patch: Partial<
        Pick<
          EditableDialogue,
          | 'caption'
          | 'start'
          | 'end'
          | 'words'
          | 'fontFamily'
          | 'fontSizePx'
          | 'lineSpacingPx'
          | 'paddingPx'
          | 'position'
          | 'bubbleId'
          | 'speakerId'
          | 'contextNote'
        >
      >;
      readonly coalesce?: CoalesceHint;
    }
  | {
      readonly type: 'split-dialogue';
      readonly dialogueId: string;
      readonly atSeconds: number;
      readonly newDialogueId: string;
    }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' };

export const emptyEditorHistory: EditorHistory = Object.freeze({
  present: null,
  past: [],
  future: [],
});

export function editorReducer(
  state: EditorHistory,
  action: EditorAction,
): EditorHistory {
  if (action.type === 'undo') return undoHistory(state);
  if (action.type === 'redo') return redoHistory(state);
  if (action.type === 'initialize') {
    if (state.present?.imageSpace.id === action.imageSpace.id) return state;
    return Object.freeze({
      ...emptyEditorHistory,
      present: Object.freeze({
        imageSpace: action.imageSpace,
        bubbles: {},
        observations: {},
        dialogues: {},
        order: [],
      }),
    });
  }
  if (action.type === 'load-project')
    return Object.freeze({ present: action.document, past: [], future: [] });
  if (!state.present) return state;
  const document = state.present;
  let next: EditorDocument = document;
  if (action.type === 'import-analysis') {
    const bubbles = { ...document.bubbles };
    const observations = { ...document.observations };
    const dialogues = { ...document.dialogues };
    const order = [...document.order];
    for (const proposal of action.bubbles) {
      if (bubbles[proposal.id] || proposal.points.length < 3) continue;
      const points = proposal.points.map((point) =>
        Object.freeze({ ...point, coordinateSpace: document.imageSpace }),
      );
      const polygon = Object.freeze({
        points: Object.freeze(points),
        coordinateSpace: document.imageSpace,
      });
      const bubble = makeBubble(
        proposal.id,
        proposal.kind,
        polygon,
        document.imageSpace,
      );
      bubbles[proposal.id] = Object.freeze({
        ...bubble,
        confidence: proposal.confidence,
        ...(proposal.classificationConfidence !== undefined
          ? { classificationConfidence: proposal.classificationConfidence }
          : {}),
        source: 'detected' as const,
        ...(proposal.detectionSources
          ? { detectionSources: Object.freeze([...proposal.detectionSources]) }
          : {}),
        reviewStatus: 'pending-review' as const,
        ...(proposal.tail
          ? {
              tail: Object.freeze({
                coordinateSpace: document.imageSpace,
                points: Object.freeze(
                  proposal.tail.map((point) =>
                    Object.freeze({
                      ...point,
                      coordinateSpace: document.imageSpace,
                    }),
                  ),
                ),
              }),
            }
          : {}),
      });
      observations[`ocr:${proposal.id}`] = Object.freeze({
        id: `ocr:${proposal.id}`,
        text: '',
        polygon: polygon,
        confidence: 0,
        coordinateSpace: document.imageSpace,
      });
      const dialogueId = `dialogue:${proposal.id}`;
      dialogues[dialogueId] = Object.freeze({
        id: dialogueId,
        bubbleId: proposal.id as BubbleId,
        caption: '',
        start: 0,
        end: 1,
        fontFamily: 'Arial',
        fontSizePx: 24,
        lineSpacingPx: 2,
        paddingPx: 4,
        position: Object.freeze({
          x: bubble.boundingBox.x + bubble.boundingBox.width / 2,
          y: bubble.boundingBox.y + bubble.boundingBox.height / 2,
          coordinateSpace: document.imageSpace,
        }),
        speakerId: '',
        contextNote: '',
      });
      order.push(dialogueId);
    }
    if (Object.keys(bubbles).length === Object.keys(document.bubbles).length)
      return state;
    next = Object.freeze({
      ...document,
      bubbles: Object.freeze(bubbles),
      observations: Object.freeze(observations),
      dialogues: Object.freeze(dialogues),
      order: Object.freeze(order),
    });
  } else if (action.type === 'import-ocr') {
    const assignments = new Map<string, (typeof action.lines)[number][]>();
    const unassigned: {
      readonly line: (typeof action.lines)[number];
      readonly classification: 'non-dialogue' | 'ambiguous';
      readonly confidence: number;
    }[] = [];
    const bubbles = Object.values(document.bubbles).filter(
      (bubble) => bubble.reviewStatus !== 'rejected',
    );
    for (const line of deduplicateOCRLines(action.lines)) {
      if (!line.text.trim() || !Number.isFinite(line.confidence)) continue;
      const match = associateOCRLine(line.boundingBox, bubbles);
      if (!/[\p{L}\p{N}]/u.test(line.text)) {
        unassigned.push({
          line,
          classification: 'non-dialogue',
          confidence: match.confidence,
        });
        continue;
      }
      if (!match.bubbleId) {
        if (match.classification === 'dialogue') continue;
        unassigned.push({
          line,
          classification: match.classification,
          confidence: match.confidence,
        });
        continue;
      }
      const assigned = assignments.get(match.bubbleId) ?? [];
      assigned.push(line);
      assignments.set(match.bubbleId, assigned);
    }
    const observations = { ...document.observations };
    const dialogues = { ...document.dialogues };
    for (const [observationId, observation] of Object.entries(observations)) {
      const bubbleId = observation.associatedBubbleId;
      if (
        !bubbleId ||
        observationId !== `ocr:${bubbleId}` ||
        observation.manuallyEdited ||
        assignments.has(bubbleId)
      )
        continue;
      delete observations[observationId];
      const dialogue = dialogues[`dialogue:${bubbleId}`];
      if (dialogue?.caption === observation.text)
        dialogues[dialogue.id] = Object.freeze({ ...dialogue, caption: '' });
    }
    for (const { line, classification, confidence } of unassigned) {
      const id = `ocr:${line.id}`;
      const previous = observations[id];
      if (previous?.manuallyEdited) continue;
      observations[id] = Object.freeze({
        id,
        text: line.text.trim(),
        rawText: line.text,
        polygon: rectPolygon(
          line.boundingBox.x,
          line.boundingBox.y,
          line.boundingBox.width,
          line.boundingBox.height,
          document.imageSpace,
        ),
        confidence: line.confidence,
        coordinateSpace: document.imageSpace,
        classification,
        reviewStatus: 'pending-review',
        associatedBubbleId: null,
        associationConfidence: confidence,
        sourceLineIds: [line.id],
      });
    }
    for (const [bubbleId, assigned] of assignments) {
      const id = `ocr:${bubbleId}`;
      const previous = observations[id];
      if (previous?.manuallyEdited) continue;
      const rows = groupOCRLines(assigned);
      const text = rows
        .map((row) => row.map((line) => line.text.trim()).join(' '))
        .join('\n');
      const bounds = unionBounds(
        assigned.map((line) => line.boundingBox),
        document.imageSpace,
      );
      observations[id] = Object.freeze({
        id,
        text,
        rawText: assigned.map((line) => line.text).join('\n'),
        polygon: rectPolygon(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          document.imageSpace,
        ),
        confidence:
          assigned.reduce((sum, line) => sum + line.confidence, 0) /
          assigned.length,
        coordinateSpace: document.imageSpace,
        classification: 'dialogue',
        reviewStatus: previous?.reviewStatus ?? 'pending-review',
        associatedBubbleId: bubbleId as BubbleId,
        associationConfidence:
          assigned.reduce(
            (sum, line) =>
              sum + associateOCRLine(line.boundingBox, bubbles).confidence,
            0,
          ) / assigned.length,
        sourceLineIds: assigned.map((line) => line.id),
      });
      const dialogue = dialogues[`dialogue:${bubbleId}`];
      if (
        dialogue &&
        (!dialogue.caption || dialogue.caption === previous?.text)
      )
        dialogues[dialogue.id] = Object.freeze({ ...dialogue, caption: text });
    }
    if (assignments.size === 0 && unassigned.length === 0) return state;
    next = Object.freeze({
      ...document,
      observations: Object.freeze(observations),
      dialogues: Object.freeze(dialogues),
    });
  } else if (action.type === 'add-bubble') {
    if (document.bubbles[action.id]) return state;
    const bubble = makeBubble(
      action.id,
      'speech',
      action.polygon,
      document.imageSpace,
    );
    const dialogueId = `dialogue:${action.id}`;
    const observationId = `ocr:${action.id}`;
    const center = {
      x: bubble.boundingBox.x + bubble.boundingBox.width / 2,
      y: bubble.boundingBox.y + bubble.boundingBox.height / 2,
      coordinateSpace: document.imageSpace,
    };
    next = Object.freeze({
      ...document,
      bubbles: Object.freeze({ ...document.bubbles, [bubble.id]: bubble }),
      observations: Object.freeze({
        ...document.observations,
        [observationId]: Object.freeze({
          id: observationId,
          text: '',
          polygon: bubble.polygon,
          confidence: 0,
          coordinateSpace: document.imageSpace,
        }),
      }),
      dialogues: Object.freeze({
        ...document.dialogues,
        [dialogueId]: Object.freeze({
          id: dialogueId,
          bubbleId: bubble.id as BubbleId,
          caption: '',
          start: 0,
          end: 1,
          fontFamily: 'Arial',
          fontSizePx: 24,
          lineSpacingPx: 2,
          paddingPx: 4,
          position: center,
          speakerId: '',
          contextNote: '',
        }),
      }),
      order: [...document.order, dialogueId],
    });
  } else if (action.type === 'delete-bubble') {
    if (!document.bubbles[action.bubbleId]) return state;
    const dialogueId = `dialogue:${action.bubbleId}`;
    const observationId = `ocr:${action.bubbleId}`;
    const bubbles = Object.fromEntries(
      Object.entries(document.bubbles).filter(([id]) => id !== action.bubbleId),
    );
    const dialogues = Object.fromEntries(
      Object.entries(document.dialogues).filter(([id]) => id !== dialogueId),
    );
    const observations = Object.fromEntries(
      Object.entries(document.observations).filter(
        ([id]) => id !== observationId,
      ),
    );
    next = Object.freeze({
      ...document,
      bubbles: Object.freeze(bubbles),
      dialogues: Object.freeze(dialogues),
      observations: Object.freeze(observations),
      order: document.order.filter((id) => id !== dialogueId),
    });
  } else if (action.type === 'review-bubble') {
    const bubble = document.bubbles[action.bubbleId];
    if (
      !bubble ||
      (bubble.reviewStatus ?? 'pending-review') === action.reviewStatus
    )
      return state;
    next = Object.freeze({
      ...document,
      bubbles: Object.freeze({
        ...document.bubbles,
        [bubble.id]: Object.freeze({
          ...bubble,
          reviewStatus: action.reviewStatus,
        }),
      }),
    });
  } else if (action.type === 'merge-bubbles') {
    const selected = [...new Set(action.bubbleIds)]
      .map((id) => document.bubbles[id])
      .filter((bubble): bubble is EditableBubble => Boolean(bubble));
    if (selected.length < 2) return state;
    const ordered = selected.sort((left, right) => {
      const leftIndex = document.order.indexOf(`dialogue:${left.id}`);
      const rightIndex = document.order.indexOf(`dialogue:${right.id}`);
      return leftIndex - rightIndex;
    });
    let polygon: Polygon<ImageSpace>;
    try {
      polygon = unionBubblePolygons(ordered.map((bubble) => bubble.polygon));
    } catch {
      return state;
    }
    const primary = ordered[0]!;
    const bubbleIds = new Set(ordered.map((bubble) => bubble.id));
    const observations = ordered
      .map((bubble) => document.observations[`ocr:${bubble.id}`]?.text.trim())
      .filter((text): text is string => Boolean(text));
    const captions = ordered
      .map((bubble) =>
        document.dialogues[`dialogue:${bubble.id}`]?.caption.trim(),
      )
      .filter((text): text is string => Boolean(text));
    const bounds = polygonBounds(polygon);
    const merged = makeBubble(
      primary.id,
      ordered.every((bubble) => bubble.kind === primary.kind)
        ? primary.kind
        : 'unknown',
      polygon,
      document.imageSpace,
    );
    const bubbles = Object.fromEntries(
      Object.entries(document.bubbles).filter(([id]) => !bubbleIds.has(id)),
    );
    bubbles[primary.id] = Object.freeze({
      ...merged,
      confidence: Math.min(...ordered.map((bubble) => bubble.confidence ?? 0)),
      source: 'manual',
      reviewStatus: 'edited',
    });
    const dialogues = Object.fromEntries(
      Object.entries(document.dialogues).filter(
        ([, dialogue]) => !bubbleIds.has(dialogue.bubbleId),
      ),
    );
    const primaryDialogue = document.dialogues[`dialogue:${primary.id}`];
    if (primaryDialogue) {
      const starts = ordered
        .map((bubble) => document.dialogues[`dialogue:${bubble.id}`]?.start)
        .filter((value): value is number => value !== undefined);
      const ends = ordered
        .map((bubble) => document.dialogues[`dialogue:${bubble.id}`]?.end)
        .filter((value): value is number => value !== undefined);
      dialogues[primaryDialogue.id] = Object.freeze({
        ...primaryDialogue,
        caption: captions.join('\n'),
        start: starts.length ? Math.min(...starts) : primaryDialogue.start,
        end: ends.length ? Math.max(...ends) : primaryDialogue.end,
        position: Object.freeze({
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          coordinateSpace: document.imageSpace,
        }),
      });
    }
    const mergedObservation = {
      id: `ocr:${primary.id}`,
      text: observations.join('\n'),
      polygon,
      confidence: Math.min(
        ...ordered.map(
          (bubble) =>
            document.observations[`ocr:${bubble.id}`]?.confidence ?? 0,
        ),
      ),
      coordinateSpace: document.imageSpace,
    };
    const nextObservations = Object.fromEntries(
      Object.entries(document.observations).filter(
        ([id]) => !ordered.some((bubble) => id === `ocr:${bubble.id}`),
      ),
    );
    nextObservations[mergedObservation.id] = Object.freeze(mergedObservation);
    const primaryDialogueId = `dialogue:${primary.id}`;
    const oldDialogueIds = new Set(
      ordered.map((bubble) => `dialogue:${bubble.id}`),
    );
    const firstPosition = Math.min(
      ...document.order.map((id, index) =>
        oldDialogueIds.has(id) ? index : Number.POSITIVE_INFINITY,
      ),
    );
    const order = document.order.filter((id) => !oldDialogueIds.has(id));
    order.splice(
      Number.isFinite(firstPosition)
        ? Math.min(firstPosition, order.length)
        : order.length,
      0,
      primaryDialogueId,
    );
    next = Object.freeze({
      ...document,
      bubbles: Object.freeze(bubbles),
      observations: Object.freeze(nextObservations),
      dialogues: Object.freeze(dialogues),
      order: Object.freeze(order),
    });
  } else if (action.type === 'split-bubble') {
    const bubble = document.bubbles[action.bubbleId];
    if (!bubble || document.bubbles[action.secondBubbleId]) return state;
    let halves: readonly [Polygon<ImageSpace>, Polygon<ImageSpace>];
    try {
      halves = splitBubblePolygon(bubble.polygon);
    } catch {
      return state;
    }
    const [firstPolygon, secondPolygon] = halves;
    const first = makeBubble(
      bubble.id,
      bubble.kind,
      firstPolygon,
      document.imageSpace,
    );
    const second = makeBubble(
      action.secondBubbleId,
      bubble.kind,
      secondPolygon,
      document.imageSpace,
    );
    const oldDialogue = document.dialogues[`dialogue:${bubble.id}`];
    const oldObservation = document.observations[`ocr:${bubble.id}`];
    const firstBounds = first.boundingBox;
    const secondBounds = second.boundingBox;
    const firstDialogue = oldDialogue
      ? Object.freeze({
          ...oldDialogue,
          position: Object.freeze({
            x: firstBounds.x + firstBounds.width / 2,
            y: firstBounds.y + firstBounds.height / 2,
            coordinateSpace: document.imageSpace,
          }),
        })
      : null;
    const secondDialogue = oldDialogue
      ? Object.freeze({
          ...oldDialogue,
          id: `dialogue:${action.secondBubbleId}`,
          bubbleId: action.secondBubbleId as BubbleId,
          caption: '',
          start: oldDialogue.start,
          end: Math.max(oldDialogue.start + 0.05, oldDialogue.end),
          position: Object.freeze({
            x: secondBounds.x + secondBounds.width / 2,
            y: secondBounds.y + secondBounds.height / 2,
            coordinateSpace: document.imageSpace,
          }),
        })
      : null;
    const firstReview = Object.freeze({
      ...first,
      ...(bubble.confidence !== undefined
        ? { confidence: bubble.confidence }
        : {}),
      source: 'manual' as const,
      reviewStatus: 'edited' as const,
    });
    const secondReview = Object.freeze({
      ...second,
      ...(bubble.confidence !== undefined
        ? { confidence: bubble.confidence }
        : {}),
      source: 'manual' as const,
      reviewStatus: 'edited' as const,
    });
    next = Object.freeze({
      ...document,
      bubbles: Object.freeze({
        ...document.bubbles,
        [bubble.id]: firstReview,
        [action.secondBubbleId]: secondReview,
      }),
      observations: Object.freeze({
        ...document.observations,
        ...(oldObservation
          ? {
              [`ocr:${bubble.id}`]: Object.freeze({
                ...oldObservation,
                polygon: firstPolygon,
              }),
              [`ocr:${action.secondBubbleId}`]: Object.freeze({
                id: `ocr:${action.secondBubbleId}`,
                text: '',
                polygon: secondPolygon,
                confidence: 0,
                coordinateSpace: document.imageSpace,
              }),
            }
          : {}),
      }),
      dialogues: Object.freeze({
        ...document.dialogues,
        ...(firstDialogue ? { [firstDialogue.id]: firstDialogue } : {}),
        ...(secondDialogue ? { [secondDialogue.id]: secondDialogue } : {}),
      }),
      order: Object.freeze(
        oldDialogue
          ? (() => {
              const index = document.order.indexOf(oldDialogue.id);
              const order = [...document.order];
              order.splice(
                index < 0 ? order.length : index + 1,
                0,
                secondDialogue!.id,
              );
              return order;
            })()
          : [...document.order],
      ),
    });
  } else if (action.type === 'edit-bubble') {
    const current = document.bubbles[action.bubbleId];
    if (!current) return state;
    const bounds = current.boundingBox;
    const x = action.patch.x ?? bounds.x;
    const y = action.patch.y ?? bounds.y;
    const width = action.patch.width ?? bounds.width;
    const height = action.patch.height ?? bounds.height;
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0 ||
      x < 0 ||
      y < 0 ||
      x + width > document.imageSpace.dimensions.width ||
      y + height > document.imageSpace.dimensions.height
    )
      return state;
    const scaleX = width / bounds.width;
    const scaleY = height / bounds.height;
    const polygon = Object.freeze({
      coordinateSpace: document.imageSpace,
      points: Object.freeze(
        current.polygon.points.map((point) =>
          Object.freeze({
            x: x + (point.x - bounds.x) * scaleX,
            y: y + (point.y - bounds.y) * scaleY,
            coordinateSpace: document.imageSpace,
          }),
        ),
      ),
    });
    const updated = makeBubble(
      current.id,
      action.patch.kind ?? current.kind,
      polygon,
      document.imageSpace,
    );
    next = Object.freeze({
      ...document,
      bubbles: Object.freeze({
        ...document.bubbles,
        [current.id]: Object.freeze({
          ...updated,
          ...(current.confidence !== undefined
            ? { confidence: current.confidence }
            : {}),
          ...(current.source ? { source: current.source } : {}),
          ...(current.tail !== undefined ? { tail: current.tail } : {}),
          reviewStatus: 'edited' as const,
        }),
      }),
      observations: document.observations[`ocr:${current.id}`]
        ? Object.freeze({
            ...document.observations,
            [`ocr:${current.id}`]: Object.freeze({
              ...document.observations[`ocr:${current.id}`]!,
              polygon,
            }),
          })
        : document.observations,
    });
  } else if (action.type === 'edit-ocr') {
    const observation = document.observations[`ocr:${action.bubbleId}`];
    if (!observation) return state;
    const dialogue = document.dialogues[`dialogue:${action.bubbleId}`];
    const preserveCaption =
      dialogue && (!dialogue.caption || dialogue.caption === observation.text);
    next = Object.freeze({
      ...document,
      observations: Object.freeze({
        ...document.observations,
        [observation.id]: Object.freeze({
          ...observation,
          text: action.text,
          manuallyEdited: true,
        }),
      }),
      ...(preserveCaption
        ? {
            dialogues: Object.freeze({
              ...document.dialogues,
              [dialogue.id]: Object.freeze({
                ...dialogue,
                caption: action.text,
              }),
            }),
          }
        : {}),
    });
  } else if (action.type === 'edit-loose-ocr') {
    const observation = document.observations[action.observationId];
    if (!observation || observation.associatedBubbleId) return state;
    next = Object.freeze({
      ...document,
      observations: Object.freeze({
        ...document.observations,
        [action.observationId]: Object.freeze({
          ...observation,
          text: action.text,
          manuallyEdited: true,
        }),
      }),
    });
  } else if (action.type === 'review-ocr-observation') {
    const observation = document.observations[action.observationId];
    if (!observation) return state;
    if (action.classification !== 'dialogue') {
      next = Object.freeze({
        ...document,
        observations: Object.freeze({
          ...document.observations,
          [observation.id]: Object.freeze({
            ...observation,
            classification: action.classification,
            reviewStatus: action.reviewStatus,
            manuallyEdited: true,
          }),
        }),
      });
    } else {
      const bubbleId = action.bubbleId ?? observation.associatedBubbleId;
      if (!bubbleId || !document.bubbles[bubbleId]) return state;
      const targetId = `ocr:${bubbleId}`;
      const previous = document.observations[targetId];
      const sourceIds = new Set([
        ...(previous?.sourceLineIds ?? []),
        ...(observation.sourceLineIds ?? []),
      ]);
      const text =
        previous && previous.id !== observation.id
          ? [previous.text, observation.text].filter(Boolean).join('\n')
          : observation.text;
      const mergedBounds = unionBounds(
        [previous, observation]
          .filter((item): item is TextObservation => Boolean(item))
          .map((item) => polygonBounds(item.polygon)),
        document.imageSpace,
      );
      const observations = { ...document.observations };
      if (observation.id !== targetId) delete observations[observation.id];
      observations[targetId] = Object.freeze({
        ...(previous ?? observation),
        id: targetId,
        text,
        polygon: rectPolygon(
          mergedBounds.x,
          mergedBounds.y,
          mergedBounds.width,
          mergedBounds.height,
          document.imageSpace,
        ),
        classification: 'dialogue',
        reviewStatus: action.reviewStatus,
        associatedBubbleId: bubbleId as BubbleId,
        manuallyEdited: true,
        sourceLineIds: [...sourceIds],
      });
      const dialogue = document.dialogues[`dialogue:${bubbleId}`];
      next = Object.freeze({
        ...document,
        observations: Object.freeze(observations),
        ...(dialogue
          ? {
              dialogues: Object.freeze({
                ...document.dialogues,
                [dialogue.id]: Object.freeze({ ...dialogue, caption: text }),
              }),
            }
          : {}),
      });
    }
  } else if (action.type === 'edit-dialogue') {
    const current = document.dialogues[action.dialogueId];
    if (!current) return state;
    const patch = action.patch;
    const start = patch.start ?? current.start;
    const end = patch.end ?? current.end;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      (patch.fontSizePx !== undefined &&
        (!Number.isFinite(patch.fontSizePx) || patch.fontSizePx <= 0)) ||
      (patch.lineSpacingPx !== undefined &&
        (!Number.isFinite(patch.lineSpacingPx) || patch.lineSpacingPx < 0)) ||
      (patch.paddingPx !== undefined &&
        (!Number.isFinite(patch.paddingPx) || patch.paddingPx < 0)) ||
      (patch.position !== undefined &&
        (!Number.isFinite(patch.position.x) ||
          !Number.isFinite(patch.position.y) ||
          patch.position.coordinateSpace.id !== document.imageSpace.id))
    )
      return state;
    next = Object.freeze({
      ...document,
      dialogues: Object.freeze({
        ...document.dialogues,
        [action.dialogueId]: Object.freeze({ ...current, ...patch }),
      }),
    });
  } else if (action.type === 'split-dialogue') {
    const current = document.dialogues[action.dialogueId];
    if (!current) return state;
    const at = action.atSeconds;
    if (!Number.isFinite(at) || at <= current.start + 0.01 || at >= current.end - 0.01) {
      return state;
    }
    const splitWords = (
      from: number,
      to: number,
    ): readonly DialogueWordTiming[] =>
      (current.words ?? []).filter(
        (word) => word.start >= from - 1e-6 && word.end <= to + 1e-6,
      );
    const first = Object.freeze({
      ...current,
      end: at,
      ...(current.words ? { words: splitWords(current.start, at) } : {}),
    });
    const second = Object.freeze({
      ...current,
      id: action.newDialogueId,
      start: at,
      ...(current.words ? { words: splitWords(at, current.end) } : {}),
    });
    const order = [...document.order];
    const index = order.indexOf(action.dialogueId);
    if (index >= 0) order.splice(index + 1, 0, action.newDialogueId);
    else order.push(action.newDialogueId);
    next = Object.freeze({
      ...document,
      dialogues: Object.freeze({
        ...document.dialogues,
        [action.dialogueId]: first,
        [action.newDialogueId]: second,
      }),
      order: Object.freeze(order),
    });
  }
  if (next === document) return state;
  const coalesce =
    action.type === 'edit-ocr' ||
    action.type === 'edit-loose-ocr' ||
    action.type === 'edit-dialogue'
      ? action.coalesce
      : undefined;
  return pushHistory(state, next, coalesce ? { coalesce } : undefined);
}

function unionBounds(
  bounds: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[],
  space: ImageSpace,
): Bounds<ImageSpace> {
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: space,
  });
}

function polygonBounds(polygon: Polygon<ImageSpace>): Bounds<ImageSpace> {
  const xs = polygon.points.map((point) => point.x);
  const ys = polygon.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return Object.freeze({
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
    coordinateSpace: polygon.coordinateSpace,
  });
}

function rectPolygon(
  x: number,
  y: number,
  width: number,
  height: number,
  space: ImageSpace,
): Polygon<ImageSpace> {
  const points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((point) => Object.freeze({ ...point, coordinateSpace: space }));
  return Object.freeze({
    points: Object.freeze(points),
    coordinateSpace: space,
  });
}

function makeBubble(
  id: string,
  kind: BubbleKind,
  polygon: Polygon<ImageSpace>,
  space: ImageSpace,
): EditableBubble {
  const xs = polygon.points.map((point) => point.x);
  const ys = polygon.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return Object.freeze({
    id,
    kind,
    polygon,
    source: 'manual',
    reviewStatus: 'edited',
    boundingBox: Object.freeze({
      x,
      y,
      width: right - x,
      height: bottom - y,
      coordinateSpace: space,
    }),
  });
}
