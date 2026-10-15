# Lettering removal (clean-page engine)

Removes original comic lettering while preserving bubble interiors, outlines,
panel borders, artwork, and page dimensions. The original upload is never
overwritten.

## Methods

| Method | When | Model download |
|--------|------|----------------|
| `white-fill` | Plain white speech balloon | None (deterministic) |
| `background-fill` | Coloured / flat interior | None (median sample) |
| `local-reconstruct` | Textured / gradient interior | None (diffusion) |
| `lama` | Text over illustrated artwork | Optional LaMa weights |
| `manual` | Unscoped user mask additions | None |
| `skipped` | Empty mask, failed method, or protected-only pixels | None |

Deterministic methods run entirely in Node/TypeScript (`packages/image-engine`).
They need no model downloads and are what the unit-test suite exercises.

### LaMa (optional)

LaMa is an optional generative fallback for text over artwork. It is **not**
enabled by default and is **not** required for tests or normal startup.

Integration strategy: a typed local adapter
(`GenerativeInpaintProvider` in `packages/image-engine/src/lettering-removal.ts`)
with a documented protocol:

```ts
interface GenerativeInpaintProvider {
  name: string;
  available(): boolean | Promise<boolean>;
  inpaint(input: {
    image: RasterImage;      // full-page RGBA
    mask: Uint8Array;        // dense page-sized 0/1 erase mask
    boundingBox: Bounds;     // tight crop hint
  }): Promise<RasterImage>;  // same dimensions as input
};
```

A local HTTP service implements this protocol:

| Piece | Path |
|-------|------|
| Python service | `scripts/lama-service.py` (stdlib HTTP + `simple-lama-inpainting`) |
| Node adapter | `apps/api/src/lama-provider.ts` |
| Weights fetch | `pnpm models:fetch:lama` → `models/lama/big-lama.pt` (~196 MiB) |

Setup (explicit, not part of `pnpm install` / `pnpm dev`):

```sh
python3 -m pip install --user simple-lama-inpainting
pnpm models:fetch:lama
pnpm lama:serve          # http://127.0.0.1:3040, loads weights (MPS/CPU)
# API process must see the service:
export COMIC_LAMA_URL=http://127.0.0.1:3040
```

Notes:

- `big-lama.pt` is a CUDA TorchScript archive. The service loads it with
  `torch.jit.load(..., map_location='cpu')` then moves to MPS/CPU. Without
  `map_location`, load crashes on machines without CUDA.
- Weights are cached under `models/lama/` (gitignored). Nothing downloads on
  ordinary server restart.
- Generative masks are capped (`maximumGenerativeMaskPixels`, default 40k) so
  LaMa cannot rewrite whole panels; oversized holes fall back to
  `local-reconstruct` with a `method-unavailable` warning.
- When LaMa is unavailable or fails: fallback to `local-reconstruct`, or
  `skipped` on failure. A failed region is **never** marked successful with
  unchanged pixels.

Probe availability via the clean-page response field `lamaAvailable` or
`GET http://127.0.0.1:3040/health`.

## API

`POST /api/clean-page`

Request JSON:

- `pageImage` — base64 PNG/JPEG **or** raw RGBA (`width` × `height` × 4)
- `width`, `height` — required for raw RGBA
- `requestId` — stale-result protection; newer requests supersede older ones
- `textRegions[]` — `id`, `boundingBox` or `polygon` or base64 `mask`,
  optional `detectionConfidence`, `associatedBubbleId`, `preferredMethod`
- `bubbles[]` — `id`, `contour.points`, optional `interiorHint`
- `manualEdits[]` — `regionId?`, `addPixels`, `excludePixels` (dense base64)
- `options.expansionPx`, `options.preferLamaForArtwork`

Response JSON:

- `cleanedPng` (base64), `removalMask` (base64 dense 0/1)
- `regions[]` — `method`, `context`, `success`, `needsReview`, confidences
- `warnings[]` — `near-outline`, `method-failed`, `low-confidence`, …
- `methodSummary` — counts per method
- `complete` — every attempted region succeeded
- `status` — `complete` | `stale` (409 for stale)

## Erasure safety policy (default)

**Bubble-interior cleaning is the default.** Unreviewed free-floating text is
never auto-erased (real-page runs showed full-page text false-positives
damaging artwork with gray fill blocks).

| Region | Default `erasureScope: 'bubble-interior'` | `erasureScope: 'approved'` |
|--------|-------------------------------------------|----------------------------|
| Associated with a bubble (`associatedBubbleId`) | Erased | Erased |
| Outside bubbles, unreviewed | **Held** (`needs-review`) | **Held** |
| Outside bubbles, `approved` / `reviewStatus: 'accepted'\|'edited'` | **Held** (`out-of-scope`) | Erased |
| `reviewStatus: 'rejected'` | Never erased | Never erased |
| Manual `addPixels` | Always applied | Always applied |

Warnings: `needs-review`, `out-of-scope`. Held regions appear in
`regions[]` with `method: 'skipped'` and `needsReview: true` so the editor
can queue them.

Auto-clean (`autoCleanPage`) uses bubble-interior ink masks only. The
`/api/clean-page` default is `erasureScope: 'bubble-interior'`; pass
`options.erasureScope: 'approved'` only after the user accepts free-floating
text regions.

## Masks and protection

1. Prefer segmentation `mask`, then `polygon`, then `boundingBox`.
2. Expand for antialiasing (`expansionPx`, default 2).
3. Near bubble/panel outlines, expansion is reduced (default to 0 extra) and
   the region is flagged `near-outline`.
4. Outline pixels derived from bubble contours (irregular shapes, tails) are
   never erased.
5. Manual `excludePixels` always win; `addPixels` join their region or create a
   `manual` fill.

## Editor

`LetteringCleanupReview` provides:

- Original vs cleaned comparison (side-by-side / single)
- Show / hide removal mask overlay
- Restore artwork (exclude from mask)
- Add missed lettering (include in mask)
- Reprocess selected regions
- Accept / reject the clean-page result
- Reset manual edits (explicit; does not drop detections)

Stale cleaning results are discarded so an old page version cannot overwrite
the current page.

## Performance

- Sequential clean queue (one full-page pass at a time) for 8 GB machines.
- Defensive copy of the raster; the caller buffer is never mutated.
- No model download on startup; LaMa is opt-in only.

## Fixture validation

```sh
# Service must be up (see LaMa setup) or omit COMIC_LAMA_URL
COMIC_LAMA_URL=http://127.0.0.1:3040 node --import tsx scripts/validate-lettering.mjs
# Force generative path on one fixture:
VALIDATE_FORCE_LAMA=difficult-lettering COMIC_LAMA_URL=http://127.0.0.1:3040 \
  node --import tsx scripts/validate-lettering.mjs
```

Outputs `output/lettering-validation/<id>/{original,cleaned,removal-mask,compare}.png`
plus `report.json` / `summary.json`. Compare sheets are
`original | cleaned | ground-truth`.

Representative MAD (mean abs RGB diff vs fixture `cleaned.png`, lower is better):

| Fixture | white-fill MAD | Notes |
|---------|----------------|-------|
| narration | 0.00 | exact |
| multiple-bubbles | 0.09 | clean |
| ellipse | 0.15 | clean |
| thought-bubble | 0.28 | clean |
| overlapping | 0.36 | clean |
| difficult-lettering | 0.39 | clean; slight outline nick |
| irregular | 0.46 | clean |
| simple | 1.16 | lettering gone; minor outline nick near tail |
| long-dialogue | 2.78 | **overflow "HE" outside balloon remains** |

LaMa on `difficult-lettering` (forced, tight masks): lettering removed, MAD 0.76
(vs 0.39 for `white-fill`). Prefer `white-fill` on plain balloons; keep LaMa
for textured artwork.

## Tests

```sh
corepack pnpm test tests/unit/lettering-removal.test.ts tests/integration/clean-page-api.test.ts
```

Synthetic fixtures cover the twelve acceptance scenarios (white balloon,
near-outline, coloured, artwork, multi-bubble, boundary cross, tail, empty,
invalid mask, failed inpaint, manual edits, repeat/stale).

### Known limitations (observed on fixtures + real scan)

1. **Overflow lettering that touches a balloon outline** (`long-dialogue`) can
   merge with the outline ink component and be dropped by text-region
   detection, so it may remain after cleaning unless a region is supplied.
2. **Outline nicking**: aggressive expansion near tails/outlines can thin the
   stroke by 1–2 px (visible on `simple`). Tune `maximumOutlineAdjacentExpansionPx`.
3. **False-positive text regions on dense artwork** (hatching, shelves, faces)
   produce gray fill blocks if full-page text detection is used without a
   tight filter. Prefer **bubble-interior ink masks** for speech cleaning.
4. **Non-balloon lettering** (phone UI, SFX, signs) needs explicit text
   regions; bubble-only mode leaves them intact by design.
5. **Partial line remnants** (e.g. "Seem-") can remain when ink components
   split across outline crossings.
6. Fixtures are synthetic vector art; the real scan below is one sample page.

## Real scanned page validation

Page: `demo_lettered_page.png` (1988×3056, multi-panel, ~12 balloons).

| Mode | Time | Result |
|------|------|--------|
| **Bubble-interior ink only** (`real-page-bubble-only/`) | **3.0 s** | 12/12 `white-fill`, `complete: true`. Speech lettering removed; outlines and artwork preserved. |
| Full text-region + ink (`real-page/`) | 442 s | Balloon text gone, but false-positive regions left gray blocks on art; 5 skipped; 108 warnings. |

Artifacts: `output/lettering-validation/real-page-bubble-only/{original,cleaned,removal-mask,crop-*}.png`

**Visually verified on the real page (bubble-only):**

- Top-left three balloons: dialogue fully cleared; tails and outlines kept.
- ICE COLD sign, character art, shelves: untouched.
- Phone panel balloons: cleared; **"Big Bruce" / "Declined" remain** (device UI, not balloons).
- **"BZZZ" SFX remains** (outside balloons).
- Minor outline thinning on one balloon tail; one remnant ("Seem-") in a balloon near the panel edge.
- Bottom-left face slightly nicked where the balloon outline meets the cheek.

**Recommendation:** production auto-clean uses **bubble-interior ink masks**
only (fast, safe). Full-page text detection is for manual review / optional
non-balloon lettering (SFX, signs, UI) and is **never auto-erased** unless
explicitly approved (`erasureScope: 'approved'`).
