/**
 * Web adapter for server-side lettering removal (`POST /api/clean-page`).
 * The original page buffer is never overwritten; cleaned PNGs are imported
 * as a separate cleaned asset.
 */

export interface CleanPageTextRegion {
  readonly id: string;
  readonly boundingBox: [number, number, number, number];
  readonly polygon?: readonly { readonly x: number; readonly y: number }[];
  readonly detectionConfidence?: number;
  readonly associatedBubbleId?: string | null;
  readonly reviewStatus?: 'pending' | 'accepted' | 'rejected' | 'edited';
  readonly approved?: boolean;
}

export interface CleanPageBubble {
  readonly id: string;
  readonly contour: readonly { readonly x: number; readonly y: number }[];
  readonly interiorHint?:
    | 'white-balloon'
    | 'coloured-balloon'
    | 'textured-balloon'
    | 'artwork'
    | 'unknown';
}

export interface CleanPageManualEdit {
  readonly regionId?: string;
  readonly addPixels?: Uint8Array;
  readonly excludePixels?: Uint8Array;
}

export interface CleanPageApiResult {
  readonly requestId: string;
  readonly status: 'complete' | 'stale';
  readonly width: number;
  readonly height: number;
  readonly cleanedPng: Uint8Array;
  readonly removalMask: Uint8Array;
  readonly regions: readonly {
    readonly id: string;
    readonly sourceRegionId: string;
    readonly method: string;
    readonly context: string;
    readonly success: boolean;
    readonly needsReview: boolean;
    readonly maskPixelCount: number;
    readonly methodConfidence: number;
  }[];
  readonly warnings: readonly {
    readonly code: string;
    readonly regionId: string;
    readonly message: string;
  }[];
  readonly methodSummary: Readonly<Record<string, number>>;
  readonly complete: boolean;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Request lettering removal for a page. `requestId` enables stale-result
 * protection: when a newer clean request is issued, older responses report
 * `status: 'stale'` and must be discarded.
 */
export async function cleanPageViaApi(input: {
  readonly imageBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly requestId?: string;
  readonly textRegions?: readonly CleanPageTextRegion[];
  readonly bubbles?: readonly CleanPageBubble[];
  readonly manualEdits?: readonly CleanPageManualEdit[];
  readonly expansionPx?: number;
  /** Default `bubble-interior`. Only `approved` also erases reviewed free text. */
  readonly erasureScope?: 'bubble-interior' | 'approved';
}): Promise<CleanPageApiResult> {
  const response = await fetch('/api/clean-page', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pageImage: bytesToBase64(input.imageBytes),
      width: input.width,
      height: input.height,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      textRegions: (input.textRegions ?? []).map((region) => ({
        id: region.id,
        boundingBox: region.boundingBox,
        ...(region.polygon ? { polygon: region.polygon } : {}),
        ...(region.detectionConfidence !== undefined
          ? { detectionConfidence: region.detectionConfidence }
          : {}),
        ...(region.associatedBubbleId !== undefined
          ? { associatedBubbleId: region.associatedBubbleId }
          : {}),
        ...(region.reviewStatus
          ? { reviewStatus: region.reviewStatus }
          : {}),
        ...(region.approved === true ? { approved: true } : {}),
      })),
      bubbles: (input.bubbles ?? []).map((bubble) => ({
        id: bubble.id,
        contour: { points: bubble.contour },
        ...(bubble.interiorHint ? { interiorHint: bubble.interiorHint } : {}),
      })),
      manualEdits: (input.manualEdits ?? []).map((edit) => ({
        ...(edit.regionId ? { regionId: edit.regionId } : {}),
        ...(edit.addPixels
          ? { addPixels: bytesToBase64(edit.addPixels) }
          : {}),
        ...(edit.excludePixels
          ? { excludePixels: bytesToBase64(edit.excludePixels) }
          : {}),
      })),
      options: {
        ...(input.expansionPx !== undefined
          ? { expansionPx: input.expansionPx }
          : {}),
        preferLamaForArtwork: true,
        erasureScope: input.erasureScope ?? 'bubble-interior',
      },
    }),
  });
  const body = (await response.json()) as {
    requestId?: string;
    status?: string;
    width?: number;
    height?: number;
    cleanedPng?: string;
    removalMask?: string;
    regions?: CleanPageApiResult['regions'];
    warnings?: CleanPageApiResult['warnings'];
    methodSummary?: CleanPageApiResult['methodSummary'];
    complete?: boolean;
    error?: { message?: string; code?: string };
  };
  if (!response.ok && body.status !== 'stale') {
    throw new Error(body.error?.message ?? 'Page cleaning failed.');
  }
  return {
    requestId: body.requestId ?? input.requestId ?? '',
    status: body.status === 'stale' ? 'stale' : 'complete',
    width: body.width ?? input.width,
    height: body.height ?? input.height,
    cleanedPng: body.cleanedPng
      ? new Uint8Array(
          Uint8Array.from(atob(body.cleanedPng), (char) => char.charCodeAt(0)),
        )
      : new Uint8Array(),
    removalMask: body.removalMask
      ? new Uint8Array(
          Uint8Array.from(atob(body.removalMask), (char) => char.charCodeAt(0)),
        )
      : new Uint8Array(input.width * input.height),
    regions: body.regions ?? [],
    warnings: body.warnings ?? [],
    methodSummary: body.methodSummary ?? {},
    complete: body.complete ?? false,
  };
}

/** Paint a dense removal mask as a red overlay PNG blob for comparison. */
export function removalMaskToOverlayPng(
  mask: Uint8Array,
  width: number,
  height: number,
): Blob {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    if (mask[i]) {
      data[i * 4] = 239;
      data[i * 4 + 1] = 68;
      data[i * 4 + 2] = 68;
      data[i * 4 + 3] = 120;
    }
  }
  // Canvas encode keeps this in the browser without sharp.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return new Blob([canvasToBytes(canvas).buffer as ArrayBuffer], {
    type: 'image/png',
  });
}

function canvasToBytes(canvas: HTMLCanvasElement): Uint8Array {
  // Synchronous fallback: data URL is fine for editor previews.
  const url = canvas.toDataURL('image/png');
  const base64 = url.slice(url.indexOf(',') + 1);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
