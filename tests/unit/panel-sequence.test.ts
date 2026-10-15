import { describe, expect, it } from 'vitest';
import {
  assignBubblesToPanels,
  buildPanelPageSequence,
  focusPlacement,
  proposePanelSequenceTimings,
  resolvePageCameraPlacement,
} from '../../packages/video-composer/src/index.js';

const panelA = {
  id: 'panel-a',
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  startSeconds: 0,
  endSeconds: 1,
};
const panelB = {
  id: 'panel-b',
  bounds: { x: 100, y: 0, width: 100, height: 100 },
  startSeconds: 1,
  endSeconds: 2,
};

describe('panel sequence timing', () => {
  it('covers the audio span with sequential shots', () => {
    const steps = proposePanelSequenceTimings({
      panels: [panelA, panelB],
      cuesByPanel: {
        'panel-a': [{ startSeconds: 0, endSeconds: 0.8 }],
        'panel-b': [{ startSeconds: 1.2, endSeconds: 2 }],
      },
      durationSeconds: 2,
    });
    expect(steps).toHaveLength(2);
    // Shot A holds until panel B's first dialogue; B holds to the end.
    expect(steps[0]!.startSeconds).toBeCloseTo(0);
    expect(steps[0]!.endSeconds).toBeCloseTo(1.2);
    expect(steps[1]!.startSeconds).toBeCloseTo(1.2);
    expect(steps[1]!.endSeconds).toBeCloseTo(2);
    expect(steps[0]!.endSeconds).toBeCloseTo(steps[1]!.startSeconds);
  });

  it('splits evenly when no panel has dialogue', () => {
    const steps = proposePanelSequenceTimings({
      panels: [
        panelA,
        panelB,
        {
          ...panelA,
          id: 'panel-c',
          bounds: { x: 0, y: 100, width: 100, height: 100 },
        },
      ],
      cuesByPanel: {},
      durationSeconds: 3,
    });
    expect(steps).toHaveLength(3);
    expect(steps[0]!.startSeconds).toBeCloseTo(0);
    expect(steps[0]!.endSeconds).toBeCloseTo(1);
    expect(steps[2]!.endSeconds).toBeCloseTo(3);
    // Contiguous coverage
    expect(steps[1]!.startSeconds).toBeCloseTo(steps[0]!.endSeconds);
    expect(steps[2]!.startSeconds).toBeCloseTo(steps[1]!.endSeconds);
  });

  it('assigns bubbles to the containing panel', () => {
    const assignment = assignBubblesToPanels(
      [
        { id: 'b1', bounds: { x: 10, y: 10, width: 20, height: 20 } },
        { id: 'b2', bounds: { x: 150, y: 10, width: 20, height: 20 } },
      ],
      [panelA, panelB],
    );
    expect(assignment['panel-a']).toEqual(['b1']);
    expect(assignment['panel-b']).toEqual(['b2']);
  });

  it('builds pages with cameraFocus and per-shot bubbles', () => {
    const { pages, cues } = buildPanelPageSequence({
      imageUrl: 'data:image/png;base64,AA==',
      pageWidth: 200,
      pageHeight: 200,
      durationSeconds: 2,
      steps: [panelA, panelB],
      bubbles: [
        {
          id: 'b1',
          polygon: [
            { x: 10, y: 10 },
            { x: 30, y: 10 },
            { x: 30, y: 30 },
            { x: 10, y: 30 },
          ],
        },
        {
          id: 'b2',
          polygon: [
            { x: 150, y: 10 },
            { x: 170, y: 10 },
            { x: 170, y: 30 },
            { x: 150, y: 30 },
          ],
        },
      ],
      cues: [
        {
          id: 'c1',
          bubbleId: 'b1',
          text: 'Hi',
          startSeconds: 0,
          endSeconds: 0.5,
          words: [],
        },
        {
          id: 'c2',
          bubbleId: 'b2',
          text: 'There',
          startSeconds: 1.2,
          endSeconds: 1.8,
          words: [],
        },
      ],
    });
    expect(pages).toHaveLength(2);
    expect(pages[0]!.cameraFocus).toBeTruthy();
    expect(pages[0]!.bubbles.map((bubble) => bubble.id)).toEqual(['b1']);
    expect(pages[1]!.bubbles.map((bubble) => bubble.id)).toEqual(['b2']);
    expect(cues).toHaveLength(2);
  });
});

describe('panel camera focus placement', () => {
  it('frames the focus rect without cropping the source page', () => {
    const placement = focusPlacement(
      200,
      200,
      { x: 0, y: 0, width: 100, height: 100 },
      100,
      100,
    );
    // Focus 100×100 in a 100×100 frame → scale 1; full page drawn at 200×200.
    expect(placement.scale).toBeCloseTo(1);
    expect(placement.width).toBeCloseTo(200);
    expect(placement.height).toBeCloseTo(200);
    // Top-left focus fills the frame exactly, so the page origin sits at 0,0.
    expect(placement.offsetX).toBeCloseTo(0);
    expect(placement.offsetY).toBeCloseTo(0);

    const centered = focusPlacement(
      200,
      200,
      { x: 50, y: 50, width: 100, height: 100 },
      100,
      100,
    );
    // Center panel is framed: page shifts left/up by the focus origin.
    expect(centered.offsetX).toBeCloseTo(-50);
    expect(centered.offsetY).toBeCloseTo(-50);
  });

  it('falls back to full-page letterbox without cameraFocus', () => {
    const placement = resolvePageCameraPlacement(
      { width: 200, height: 100 },
      100,
      100,
    );
    expect(placement.scale).toBeCloseTo(0.5);
    expect(placement.offsetX).toBeCloseTo(0);
    expect(placement.offsetY).toBeCloseTo(25);
  });
});
