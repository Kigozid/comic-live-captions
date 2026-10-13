import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createImageSpace, type Bounds, type ImageSpace } from '@comic-captioner/shared';
import {
  BubbleDetectionEngine,
  HeuristicProposalProvider,
  HybridBubbleDetectionError,
  HybridBubbleDetector,
  type BubbleProposal,
  type BubbleProposalProvider,
} from '@comic-captioner/bubble-engine';
import { createBubbleFixture } from '../fixtures/bubble-fixtures';

const width = 400;
const height = 300;
const pageSpace = createImageSpace('hybrid-page', width, height);

function box(
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
  space: ImageSpace = pageSpace,
): Bounds<ImageSpace> {
  return { x, y, width: boxWidth, height: boxHeight, coordinateSpace: space };
}

class StubProvider implements BubbleProposalProvider {
  readonly name: string;
  readonly provenance: 'heuristic' | 'ml';
  readonly #proposals: readonly BubbleProposal[];
  calls = 0;

  constructor(
    proposals: readonly BubbleProposal[],
    provenance: 'heuristic' | 'ml' = 'ml',
    name = 'stub-ml',
  ) {
    this.#proposals = proposals;
    this.provenance = provenance;
    this.name = name;
  }

  propose(): readonly BubbleProposal[] {
    this.calls += 1;
    return this.#proposals;
  }
}

/** Gray page with one pale bubble the default deterministic thresholds miss. */
async function createPaleBubblePage(): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#999"/><ellipse cx="200" cy="150" rx="80" ry="60" fill="#c8c8c8" stroke="#111" stroke-width="4"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

describe('HybridBubbleDetector', () => {
  it('merges provider proposals with deterministic bubbles by IoU', async () => {
    const image = await createBubbleFixture('ellipse', width, height);
    const deterministic = new BubbleDetectionEngine();
    const baseline = await deterministic.detect(image, pageSpace);
    expect(baseline.bubbles.length).toBeGreaterThan(0);
    const detectedBox = baseline.bubbles[0]!.boundingBox;
    // A provider box that substantially overlaps the deterministic bubble.
    const provider = new StubProvider([
      {
        id: 'ml-1',
        boundingBox: box(
          detectedBox.x + 4,
          detectedBox.y + 4,
          detectedBox.width - 8,
          detectedBox.height - 8,
        ),
        confidence: 0.8,
        provenance: 'ml',
      },
    ]);
    const detector = new HybridBubbleDetector({ provider });
    const result = await detector.detect(image, pageSpace);

    expect(result.bubbles).toHaveLength(1);
    expect(result.deterministicCount).toBe(1);
    expect(result.proposalCount).toBe(1);
    expect(result.mergedCount).toBe(1);
    expect(result.refinedCount).toBe(0);
    expect(result.providerName).toBe('stub-ml');
    const merged = result.bubbles[0]!;
    expect(merged.sources).toEqual(['detected', 'ml']);
    expect(merged.support).toHaveLength(1);
    expect(merged.support[0]!.proposalId).toBe('ml-1');
    expect(merged.support[0]!.iou).toBeGreaterThan(0.5);
    expect(merged.support[0]!.provenance).toBe('ml');
    // Geometry stays the deterministic contour.
    expect(merged.bubble.id).toBe(baseline.bubbles[0]!.id);
    expect(merged.bubble.contour.points.length).toBeGreaterThan(10);
    expect(merged.bubble.confidence).toBeGreaterThanOrEqual(
      baseline.bubbles[0]!.confidence,
    );
    // Quality metrics are computed deterministically for every result.
    expect(merged.quality.fillRatio).toBeGreaterThan(0.5);
    expect(merged.quality.score).toBeGreaterThan(0.3);
    expect(merged.quality.boundaryContrast).toBeGreaterThan(10);
  });

  it('refines an unmatched proposal with deterministic geometry when the deterministic pass missed it', async () => {
    const image = await createPaleBubblePage();
    const deterministic = new BubbleDetectionEngine();
    const baseline = await deterministic.detect(image, pageSpace);
    expect(baseline.bubbles).toHaveLength(0);

    const provider = new StubProvider([
      {
        id: 'ml-pale',
        boundingBox: box(110, 82, 180, 136),
        confidence: 0.72,
        provenance: 'ml',
      },
    ]);
    const detector = new HybridBubbleDetector({ provider });
    const result = await detector.detect(image, pageSpace);

    expect(result.deterministicCount).toBe(0);
    expect(result.refinedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.bubbles).toHaveLength(1);
    const refined = result.bubbles[0]!;
    expect(refined.sources).toEqual(['detected', 'ml']);
    expect(refined.support[0]!.proposalId).toBe('ml-pale');
    expect(refined.bubble.source).toBe('detected');
    expect(refined.bubble.reviewStatus).toBe('pending-review');
    expect(refined.bubble.contour.points.length).toBeGreaterThan(6);
    expect(refined.bubble.polygon.points.length).toBeGreaterThanOrEqual(3);
    expect(refined.bubble.mask.runs.length).toBeGreaterThan(0);
    expect(refined.bubble.boundingBox.coordinateSpace.id).toBe(pageSpace.id);
    expect(refined.bubble.boundingBox.x).toBeGreaterThan(100);
    expect(refined.bubble.boundingBox.width).toBeGreaterThan(120);
    expect(refined.quality.score).toBeGreaterThanOrEqual(0.42);
  });

  it('rejects unmatched proposals on flat backgrounds', async () => {
    const image = await createPaleBubblePage();
    const provider = new StubProvider([
      {
        id: 'ml-empty',
        boundingBox: box(12, 12, 60, 40),
        confidence: 0.9,
        provenance: 'ml',
      },
    ]);
    const detector = new HybridBubbleDetector({ provider });
    const result = await detector.detect(image, pageSpace);
    expect(result.bubbles).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it('runs deterministic-only detection when no provider is configured', async () => {
    const image = await createBubbleFixture('ellipse', width, height);
    const detector = new HybridBubbleDetector();
    const result = await detector.detect(image, pageSpace);

    expect(result.providerName).toBeNull();
    expect(result.proposalCount).toBe(0);
    expect(result.mergedCount).toBe(0);
    expect(result.refinedCount).toBe(0);
    expect(result.deterministicCount).toBeGreaterThan(0);
    expect(result.bubbles).toHaveLength(result.deterministicCount);
    for (const entry of result.bubbles) {
      expect(entry.sources).toEqual(['detected']);
      expect(entry.support).toEqual([]);
      expect(entry.quality.score).toBeGreaterThan(0);
    }
  });

  it('runs the heuristic provider on a synthetic page and merges by IoU', async () => {
    const image = await createBubbleFixture('ellipse', width, height);
    const heuristic = new HeuristicProposalProvider();
    const proposals = await heuristic.propose(image, pageSpace);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]!.provenance).toBe('heuristic');
    expect(proposals[0]!.confidence).toBeGreaterThan(0.4);
    expect(proposals[0]!.boundingBox.coordinateSpace.id).toBe(pageSpace.id);

    const detector = new HybridBubbleDetector({ provider: heuristic });
    const result = await detector.detect(image, pageSpace);
    expect(result.bubbles).toHaveLength(1);
    expect(result.mergedCount).toBeGreaterThan(0);
    const merged = result.bubbles[0]!;
    expect(merged.sources).toContain('detected');
    expect(merged.sources).toContain('heuristic');
    expect(merged.support[0]!.provider).toBe('heuristic-proposal-provider');
  });

  it('rejects structurally invalid provider output', async () => {
    const image = await createBubbleFixture('ellipse', width, height);
    const missingId = new StubProvider([
      {
        id: '  ',
        boundingBox: box(50, 50, 40, 40),
        confidence: 0.5,
        provenance: 'ml',
      },
    ]);
    await expect(
      new HybridBubbleDetector({ provider: missingId }).detect(image, pageSpace),
    ).rejects.toThrow(/Proposal ID/);

    const badConfidence = new StubProvider([
      {
        id: 'ml-2',
        boundingBox: box(50, 50, 40, 40),
        confidence: 1.4,
        provenance: 'ml',
      },
    ]);
    await expect(
      new HybridBubbleDetector({ provider: badConfidence }).detect(
        image,
        pageSpace,
      ),
    ).rejects.toThrow(/confidence/);

    const badBounds = new StubProvider([
      {
        id: 'ml-3',
        boundingBox: box(50, 50, -4, 40),
        confidence: 0.5,
        provenance: 'ml',
      },
    ]);
    await expect(
      new HybridBubbleDetector({ provider: badBounds }).detect(image, pageSpace),
    ).rejects.toThrow(/Proposal bounds/);
  });

  it('rejects invalid hybrid options', async () => {
    const image = await createBubbleFixture('ellipse', width, height);
    const detector = new HybridBubbleDetector({
      hybrid: { mergeIouThreshold: 0 },
    });
    await expect(detector.detect(image, pageSpace)).rejects.toThrow(
      HybridBubbleDetectionError,
    );
  });
});
