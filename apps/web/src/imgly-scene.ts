/**
 * Best-effort inspector for IMG.LY CE.SDK `.imgly` scene files.
 *
 * The supplied scene is a base64-wrapped binary with magic `UBQ2` (decoded
 * payload starts `P\x146(...`). It is not ZIP/JSON/zlib/gzip/brotli and has no
 * embedded ASCII track/clip strings, so full scene decode needs official
 * CE.SDK tooling. This module records what *can* be verified safely and never
 * invents timeline content from the sample advertisement.
 */

export interface ImglySceneInspection {
  readonly format: 'imgly';
  readonly byteLength: number;
  readonly decodedByteLength: number;
  readonly magic: string | null;
  readonly parseable: boolean;
  readonly encodingGuess: string;
  readonly notes: readonly string[];
  readonly extracted: {
    readonly canvas: { width: number; height: number } | null;
    readonly tracks: readonly unknown[];
    readonly clips: readonly unknown[];
    readonly textLayers: readonly string[];
  };
}

function readMagic(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  return String.fromCharCode(...bytes.subarray(0, 4));
}

function tryBase64(input: Uint8Array): Uint8Array | null {
  try {
    const text = new TextDecoder().decode(input);
    const cleaned = text.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(cleaned) || cleaned.length < 16) return null;
    const out = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
    return out.length > 0 && out.length !== input.length ? out : null;
  } catch {
    return null;
  }
}

function extractAsciiRuns(bytes: Uint8Array, minLength = 6): string[] {
  const runs: string[] = [];
  let current = '';
  for (const byte of bytes) {
    if (byte >= 0x20 && byte < 0x7f) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) runs.push(current);
      current = '';
    }
  }
  if (current.length >= minLength) runs.push(current);
  return runs;
}

export function inspectImglyScene(
  raw: Uint8Array | ArrayBuffer | string,
): ImglySceneInspection {
  const notes: string[] = [];
  let source: Uint8Array;
  if (typeof raw === 'string') {
    const cleaned = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    source = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
    notes.push('Input was base64 text; decoded to binary.');
  } else if (raw instanceof ArrayBuffer) {
    source = new Uint8Array(raw);
  } else {
    source = raw;
  }

  let payload = source;
  const head = readMagic(source);
  if (head && /^[A-Z0-9]{4}$/.test(head)) {
    notes.push(`File magic ${head} indicates a proprietary CE.SDK archive.`);
    const unlayered = tryBase64(source);
    if (unlayered) {
      payload = unlayered;
      notes.push('Outer layer was base64; decoded payload for inspection.');
    }
  } else {
    const unlayered = tryBase64(source);
    if (unlayered) {
      payload = unlayered;
      notes.push('Decoded base64 wrapper.');
    }
  }

  const payloadMagic = readMagic(payload);
  const text = new TextDecoder('latin1').decode(payload);
  const hasJson = text.includes('{') && text.includes('"');
  const hasZip = payload[0] === 0x50 && payload[1] === 0x4b;
  const runs = extractAsciiRuns(payload).filter((run) =>
    /track|clip|scene|duration|fps|width|height|audio|text|video|image/i.test(run),
  );

  if (hasZip) notes.push('Payload looks like a ZIP container.');
  if (hasJson) notes.push('Payload contains JSON-like text.');
  if (runs.length > 0) {
    notes.push(`Found ${runs.length} ASCII metadata run(s).`);
  }
  if (!hasZip && !hasJson && runs.length === 0) {
    notes.push(
      'Payload is not ZIP/JSON/zlib/gzip/brotli; full scene properties require CE.SDK runtime.',
    );
    notes.push(
      'Canvas size, tracks, and clip timings are intentionally left empty — not invented from the sample ad.',
    );
  }

  // Heuristic canvas guess only when an explicit WxH run exists.
  let canvas: { width: number; height: number } | null = null;
  for (const run of runs) {
    const match = /(\d{2,5})\s*[x×]\s*(\d{2,5})/.exec(run);
    if (match) {
      canvas = { width: Number(match[1]), height: Number(match[2]) };
      notes.push(`Guessed canvas ${canvas.width}×${canvas.height} from metadata text.`);
      break;
    }
  }

  return {
    format: 'imgly',
    byteLength: source.byteLength,
    decodedByteLength: payload.byteLength,
    magic: payloadMagic ?? head,
    parseable: hasZip || hasJson,
    encodingGuess: hasZip
      ? 'zip'
      : hasJson
        ? 'json'
        : payloadMagic === 'UBQ2'
          ? 'ubq2-proprietary'
          : 'unknown',
    notes,
    extracted: {
      canvas,
      tracks: [],
      clips: [],
      textLayers: runs.slice(0, 20),
    },
  };
}

/** Read a File/Blob from an `<input type=file>` and inspect it. */
export async function inspectImglyFile(file: Blob): Promise<ImglySceneInspection> {
  const buffer = await file.arrayBuffer();
  return inspectImglyScene(buffer);
}
