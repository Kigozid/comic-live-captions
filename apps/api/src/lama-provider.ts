import type { RasterImage } from '@comic-captioner/image-engine';
import type {
  GenerativeInpaintProvider,
} from '@comic-captioner/image-engine';

/**
 * HTTP client for `scripts/lama-service.py`.
 *
 * Implements `GenerativeInpaintProvider` so the lettering-removal engine can
 * call Big-LaMa only on tight text masks. When the service is down the
 * engine falls back to deterministic reconstruction and reports a warning —
 * never a silent unchanged success.
 */

export interface LamaHttpClientOptions {
  /** Base URL of the local service. Default `http://127.0.0.1:3040`. */
  readonly baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 60_000. */
  readonly timeoutMs?: number;
}

export class LamaHttpError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'REQUEST_FAILED' | 'BAD_RESPONSE',
    message: string,
  ) {
    super(message);
    this.name = 'LamaHttpError';
  }
}

export class LamaHttpProvider implements GenerativeInpaintProvider {
  readonly name = 'lama-http';
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: LamaHttpClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3040').replace(
      /\/+$/,
      '',
    );
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    Object.freeze(this);
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.#baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(this.#timeoutMs, 3_000)),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { ready?: boolean };
      return body.ready === true;
    } catch {
      return false;
    }
  }

  async inpaint(input: {
    image: RasterImage;
    mask: Uint8Array;
    boundingBox: { x: number; y: number; width: number; height: number };
  }): Promise<RasterImage> {
    const { width, height, data } = input.image;
    if (input.mask.length !== width * height) {
      throw new LamaHttpError(
        'BAD_RESPONSE',
        'LaMa mask size does not match the page raster.',
      );
    }
    // Send only the RGB bytes (LaMa is RGB). Avoid an extra full RGBA copy
    // beyond this required conversion for 8 GB machines.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
      rgb[j] = data[i * 4]!;
      rgb[j + 1] = data[i * 4 + 1]!;
      rgb[j + 2] = data[i * 4 + 2]!;
    }

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/inpaint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: bytesToBase64(rgb),
          mask: bytesToBase64(input.mask),
          width,
          height,
          imageEncoding: 'raw-rgb',
          maskEncoding: 'raw',
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new LamaHttpError(
        'UNAVAILABLE',
        `LaMa service unreachable at ${this.#baseUrl}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
      );
    }

    const body = (await response.json()) as {
      ok?: boolean;
      image?: string;
      width?: number;
      height?: number;
      error?: string;
    };
    if (!response.ok || body.ok !== true || typeof body.image !== 'string') {
      throw new LamaHttpError(
        'REQUEST_FAILED',
        body.error ?? `LaMa service returned HTTP ${response.status}.`,
      );
    }
    const png = base64ToBytes(body.image);
    const decoded = await decodePngToRgba(png);
    if (decoded.width !== width || decoded.height !== height) {
      throw new LamaHttpError(
        'BAD_RESPONSE',
        `LaMa returned ${decoded.width}×${decoded.height}; expected ${width}×${height}.`,
      );
    }
    return decoded;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString('base64');
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function decodePngToRgba(png: Uint8Array): Promise<RasterImage> {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

/** Build a provider when `COMIC_LAMA_URL` (or default port) is configured. */
export function createLamaProviderFromEnv(): LamaHttpProvider | null {
  const url = process.env.COMIC_LAMA_URL;
  if (url === 'off' || url === 'disabled') return null;
  return new LamaHttpProvider({
    ...(url ? { baseUrl: url } : {}),
  });
}
