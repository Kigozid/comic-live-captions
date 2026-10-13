# Comic Captioner — Processing Pipeline

**Status:** proposed workflow; no pipeline implementation exists in this
repository yet. See [architecture.md](architecture.md) for the system model,
service contracts, and coordinate-space rules.

The workflow maps to the proposed monorepo as follows: `apps/web` presents and
edits workflow state; `apps/api` schedules jobs and wires adapters;
`packages/core` validates transitions and commits accepted results;
`image-engine` handles image operations/alignment and the OCR port;
`bubble-engine` handles bubble and safe-region geometry;
`audio-engine` handles media/timebase and transcription; `ai` handles semantic
proposals; `caption-engine` fits captions and builds the timeline; and
`rendering` previews and exports. Shared request/result schemas live in
`shared`. This ownership is proposed rather than implemented.

## Pipeline overview

```text
Original page ─┐
               ├─> decode and define asset spaces
Cleaned page ──┘          │
                          ├─> register cleaned → original page
                          ├─> compare pixels / derive masks
                          ├─> OCR observations ──────────────┐
                          ├─> detect bubble candidates       │
                          └─> derive interior/safe regions   │
                                                            │
Audio ─> decode/timebase ─> transcript proposals ───────────┤
                                                            ▼
             semantic dialogue mapping proposals + human review
                              │ approved dialogue ↔ bubble links
                              ▼
                 shape-aware caption fitting and review
                              │ approved layouts
                              ▼
                 audio timeline and synchronization
                              │ frozen validated snapshot
                              ▼
                   preview / render / export
```

Stages can be retried or revised. Each derived result records input IDs/hashes,
revision, algorithm/model version, coordinate spaces or timebase, and
provenance. A changed upstream input invalidates dependent derived output. User
edits remain recorded and are surfaced for reconciliation rather than silently
overwritten.

## Stage contracts and review gates

| Stage               | Inputs                                                                 | Outputs                                                                                    | Gate / failure behavior                                                                 |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Asset ingest        | Original page, cleaned page, audio                                     | Immutable asset refs, metadata, hashes, asset coordinate spaces, audio timebase            | Reject unsupported/corrupt media; no source overwrite                                   |
| Page alignment      | Original and cleaned page image refs                                   | Candidate directed transform `cleaned asset space → canonical page space`, quality metrics | Low quality or review-required transform blocks merged downstream geometry              |
| Image comparison    | Images, accepted transform                                             | Aligned derived image, difference map/masks                                                | Every raster/mask declares its pixel space and sampling transform                       |
| Text analysis       | Original/cleaned page image, declared region/space                     | OCR text observations, polygons, confidence, provenance                                    | Validate schema and geometry; user edits produce accepted text records                  |
| Bubble detection    | Page image, optional text/difference features                          | Candidate contours, tails, classification evidence                                         | Candidate polygons remain in declared space; ambiguous classification is reviewable     |
| Region derivation   | Accepted bubble geometry and text occupancy                            | Bubble interior, occupied area, caption-safe polygon/mask                                  | Deterministic containment/quality checks; failure yields no usable region               |
| Audio transcription | Audio asset and timebase                                               | Transcript segment/word proposals with time intervals                                      | Validate bounds/order/overlaps; uncertain text/timing goes to review                    |
| Dialogue mapping    | OCR observations, transcript, bubble candidates, reading order         | Candidate text/transcript/bubble links, confidence/evidence                                | Ambiguous mapping stays pending; never auto-commit model output                         |
| Caption fitting     | Accepted dialogue text, selected bubble safe region, fonts/constraints | Layout geometry, wrapped runs, fit diagnostics                                             | Fit must remain in region; report impossible fits for manual action                     |
| Timeline            | Accepted dialogue links, transcript times, user edits                  | Cues in audio timebase                                                                     | Validate cue bounds and layout references; reconcile overlaps explicitly                |
| Render/export       | Frozen project revision, page, approved layouts, timeline, settings    | Preview frames or immutable export artifact                                                | Fail preflight on unresolved links/geometry/assets; captions render inside bubbles only |

## Coordinate flow

Every image geometry value carries a resolvable coordinate-space declaration.
Source image detections remain in their source ImageSpace. The accepted
alignment transform explicitly maps cleaned-page coordinates into the
original page's canonical ImageSpace. Geometry is transformed before it is
combined; the original detection is retained with provenance. Safe regions
and final caption geometry use the canonical page ImageSpace. A preview applies
a separate ImageSpace-to-DisplaySpace mapping, with any physical canvas DPR
conversion represented as DisplaySpace-to-CanvasSpace. These transient
viewport mappings never change persisted geometry.

Masks declare both their grid dimensions/space and the mapping from mask pixels
to the associated asset/page space. Any crop, scale, rotation, orientation
normalization, or resampling creates or references a distinct space and a
directed transform. Consumers reject unknown or stale spaces rather than
assuming all `(x,y)` values are comparable.

## Alignment estimate (M04)

The current `ImageAlignmentEngine` decodes immutable source images, creates
small grayscale analysis rasters, then uses deterministic gradient/intensity
correlation over a bounded similarity-transform search. It reports the
cleaned-to-original 2D affine matrix, extracted scale/rotation/translation,
normalized confidence, concrete source/target ImageSpaces, and algorithm
version. Automatic estimates are shown with confidence and can be replaced by
manual scale, rotation, and target-image-pixel translation values. The review
API renders a registered overlay or absolute grayscale difference image; the
original assets are never modified.

Automatic search currently targets modest edits (scale within roughly 6%,
rotation within 6 degrees, and translation within roughly 8% of the analysis
side). Images with materially different aspect ratios are rejected because
they cannot be represented by the uniform-scale similarity model. This bounded
search is an initial deterministic baseline, not a promise to register
perspective changes, local warps, or heavily edited pages.

## Removed-text differences (M05)

The `TextDifferenceEngine` compares aligned grayscale rasters and selects
directional changes where dark original ink became lighter in the cleaned
page. It closes small gaps, removes tiny connected noise, labels connected
components, groups neighboring glyph-like shapes, and scores candidates using
aspect ratio, relative height, density, and component repetition. Solid or
large unrelated edits are therefore less likely to be proposed, though
ambiguous regions still require review. Each result polygon and bounding box
uses the original page ImageSpace; its compact run-length mask declares a
MaskSpace and per-axis mapping to that page. A debug image marks likely text
regions in red and other pixel changes in blue. This stage does not detect or
classify speech bubbles.

## Semantic proposal flow

OCR, transcription, comic understanding, classification, and dialogue mapping
may use AI. Each request is bounded to its task and explicit schema. The adapter
validates the response and records confidence, model/provider/version, input
hashes, and trace metadata. Results enter a proposal/review queue. Acceptance or
editing is a `ProjectService` command with expected project revision; only that
command changes canonical project state. Geometry engines validate and derive
all regions/layouts deterministically from accepted inputs.

## Invalidation and reproducibility

Use content hashes plus algorithm/options versions to key reusable derived
artifacts. Examples: OCR depends on the chosen normalized image and OCR config;
bubble geometry depends on page revision and detector version; safe regions
depend on bubble geometry plus text occupancy; caption layouts depend on text,
safe region, font metrics, and fitting constraints; exports depend on the
frozen project revision and renderer settings/version. Persist enough metadata
to explain and reproduce an analysis. A manual correction supersedes the
relevant accepted value while retaining the original proposal and audit trail.

## User-visible progress

Long tasks report stable job ID, stage, status, progress when measurable,
cancellation support, and actionable error details. Progress is informational;
the client refreshes the project revision before applying results. A failed or
cancelled job leaves source assets and previously accepted project state intact.
