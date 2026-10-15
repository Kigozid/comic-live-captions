#!/usr/bin/env node
/**
 * Download optional Big-LaMa weights for generative lettering removal.
 *
 * Not part of `pnpm models:fetch` or dev startup. Requires ~200 MiB.
 *
 *   node scripts/fetch-lama.mjs
 *   # or: pnpm models:fetch:lama
 *
 * Destination: models/lama/big-lama.pt (gitignored)
 * Then start the service: python3 scripts/lama-service.py --preload
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const url =
  process.env.LAMA_MODEL_URL ??
  'https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt';
const dest = join(root, 'models/lama/big-lama.pt');

try {
  await access(dest, constants.R_OK);
  console.log(`skip  Big-LaMa (already present at ${dest})`);
  process.exit(0);
} catch {
  // download below
}

console.log('fetch Big-LaMa (big-lama.pt)');
console.log(`      ${url}`);
await mkdir(dirname(dest), { recursive: true });
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) {
  console.error(`fail  HTTP ${response.status}`);
  process.exit(1);
}
const buffer = Buffer.from(await response.arrayBuffer());
await writeFile(dest, buffer);
console.log(
  `ok    Big-LaMa → ${dest} (${(buffer.length / 1024 / 1024).toFixed(1)} MiB)`,
);
