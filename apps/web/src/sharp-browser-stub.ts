/**
 * Browser stand-in for the Node-only `sharp` package.
 * Image processing runs on the API; this stub only keeps the web bundle loadable.
 */
export default function sharp(): never {
  throw new Error(
    'sharp is not available in the browser. Use the API image endpoints instead.',
  );
}

export type FormatEnum = Record<string, unknown>;
