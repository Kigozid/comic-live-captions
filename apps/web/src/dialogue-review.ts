import { DialogueMappingEngine } from '../../../packages/ai/src/dialogue-mapping.js';
import type { DialogueMapping } from '@comic-captioner/core';
import type { Transcript } from '@comic-captioner/audio-engine';
import type { BubbleDialogueReference } from '@comic-captioner/core';
import type { BubbleId } from '@comic-captioner/shared';
import type { EditorDocument } from './editor-model.js';

/** Builds fresh deterministic, review-only mappings from edited OCR and transcript data. */
export function proposeTranscriptBubbleMappings(
  document: EditorDocument | null,
  transcript: Transcript | null,
  readingOrder?: readonly string[] | null,
): readonly DialogueMapping[] {
  if (!document || !transcript?.segments.length) return [];
  const references: BubbleDialogueReference[] = document.order.flatMap(
    (dialogueId) => {
      const dialogue = document.dialogues[dialogueId];
      const observation =
        dialogue && document.observations[`ocr:${dialogue.bubbleId}`];
      if (!dialogue || !observation?.text.trim()) return [];
      const xs = observation.polygon.points.map((point) => point.x);
      const ys = observation.polygon.points.map((point) => point.y);
      if (xs.length < 3 || ys.length < 3) return [];
      return [
        {
          id: `reference:${dialogue.bubbleId}`,
          bubbleId: dialogue.bubbleId,
          textRegionIds: [observation.id],
          originalText: observation.text,
          originalTextBounds: {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
            coordinateSpace: document.imageSpace,
          },
          lineCount: observation.text.split(/\n/).length,
          alignment: 'unknown',
          confidence: observation.confidence,
          status: 'pending-review',
          method: 'spatial',
          revision: 1,
        },
      ];
    },
  );
  if (!references.length) return [];
  const referenceIds = references.map((ref) => ref.bubbleId);
  // Prefer explicit panel reading order when it covers every bubble;
  // otherwise fall back to document order. Content match stays primary.
  const orderedIds =
    readingOrder &&
    readingOrder.length === references.length &&
    referenceIds.every((id) => readingOrder.includes(id))
      ? (readingOrder as BubbleId[])
      : (referenceIds as BubbleId[]);
  return new DialogueMappingEngine().map({
    bubbleReferences: references,
    readingOrder: orderedIds,
    transcriptSegments: transcript.segments,
  }).mappings;
}
