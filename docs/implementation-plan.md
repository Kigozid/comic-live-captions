# Comic Captioner — Implementation Plan

**Status:** proposed milestone sequence, revised to match the requested M01–M23
order. See [architecture.md](architecture.md) and [pipeline.md](pipeline.md)
for the target boundaries and contracts. No implementation is present in the
current workspace.

## Delivery rules

Complete milestones in order unless an explicit dependency is independently
pulled forward. Each milestone is independently testable and leaves the root
workspace checks green and both web and API processes runnable. M01 creates a
real web shell and API health endpoint, not fake comic-processing controls.
Until M17, project data and imported media may live in clearly labeled
in-memory/dev state; M17 adds durability. Do not imply data survives restart
before then. Each milestone integrates one cohesive capability, reports
failures accurately, and preserves previously completed flows.

All image geometry crossing a package, API, storage, or rendering boundary
must declare its coordinate space and geometry revision. All media timing must
declare its timebase and units. AI output is schema-validated, confidence-scored,
provenanced, and treated as a proposal until accepted through core commands.
Deterministic code owns geometry, fitting, timeline behavior, and rendering.

## Milestones

### M01 — Foundation

- **Objective:** Create the pnpm monorepo and a continuously runnable web/API baseline.
- **Inputs:** Approved repository tree and architecture; supported Node/pnpm versions selected and recorded.
- **Outputs:** Root scripts and workspace config; apps/packages manifests; web shell; API health/readiness endpoint; lint/typecheck/test wiring; setup README.
- **Affected packages:** Root; `apps/web`; `apps/api`; `packages/*`; `tests/`; `scripts/`.
- **Tests:** Clean-install workspace smoke; lint/typecheck/unit commands; start API and check health; start web and load page.
- **Acceptance criteria:** A clean checkout can run both apps from documented commands; checks pass; UI clearly indicates no comic processing is available yet.
- **Dependencies:** None.

### M02 — Image import

- **Objective:** Import original and cleaned comic page images as distinct, validated project inputs.
- **Inputs:** M01 runnable apps; selected supported image formats and size limits.
- **Outputs:** Image import endpoint and setup UI; source/cleaned role labels; immutable in-memory asset references; decode errors and basic metadata.
- **Affected packages:** `apps/web`; `apps/api`; `packages/core`; `packages/image-engine`; `packages/shared`.
- **Tests:** Valid format/import; corrupt/unsupported/oversized files; role distinction; source bytes unchanged; browser import flow.
- **Acceptance criteria:** A user can add both page images and see their status; invalid input fails clearly; behavior is explicitly session/dev-memory scoped until M17.
- **Dependencies:** M01.

### M03 — Coordinate system

- **Objective:** Define and validate the image, display, canvas, normalized, and export coordinate spaces before geometry analysis.
- **Inputs:** M02 immutable image metadata; coordinate conventions from `architecture.md`.
- **Outputs:** Shared typed spaces and space-tagged geometry; pixel-center/edge conventions; reversible image/display, image/normalized, image/export, and display/canvas mappings; M02 viewers driven by image-to-display mappings.
- **Affected packages:** `packages/shared`; `packages/core`; `apps/web`; unit tests; architecture documentation.
- **Tests:** Scaling, zoom, pan, varying image/export resolutions, pixel-center and normalized edge behavior, DPR including fractional DPR, reversible conversion and space mismatch rejection.
- **Acceptance criteria:** Geometry declares a concrete coordinate space; page geometry remains in image pixels; display and canvas transforms are transient; all required conversions round-trip within floating-point tolerance; no alignment is introduced.
- **Dependencies:** M02.

### M04 — Alignment

- **Objective:** Estimate and review a deterministic transform from cleaned-page coordinates to canonical original-page coordinates.
- **Inputs:** M02 images and M03 coordinate spaces.
- **Outputs:** Deterministic registration and coordinate-tagged transform in `image-engine`; API estimate/manual-correction endpoints; aligned overlay and absolute difference visualization; confidence and algorithm version.
- **Affected packages:** `packages/image-engine`; `packages/core`; `apps/api`; `apps/web`.
- **Tests:** Synthetic known transforms; scaled/rotated/noisy pairs; direction and round-trip tolerance; low-quality registration review; varied page dimensions.
- **Acceptance criteria:** Every transform declares cleaned source and original target spaces; confidence is visible for review and manual correction remains available; no comic-specific sample coordinates are hard-coded.
- **Dependencies:** M03.

### M05 — Difference detection

- **Objective:** Produce aligned pixel-difference images and masks to identify edits between original and cleaned pages.
- **Inputs:** M02 source images; M04 accepted alignment; M03 coordinate and resampling contracts.
- **Outputs:** Directional removed-ink difference mask; deterministic noise/morphology cleanup, connected components and spatial grouping; scored text-like `TextRegion[]` in page ImageSpace with cropped MaskSpace masks; debug and binary difference visualizations; aligned-image API endpoint.
- **Affected packages:** `packages/image-engine`; `packages/shared`; `apps/api`; `apps/web`.
- **Tests:** Identical pages; synthetic removed glyphs; unrelated solid edits and isolated noise; resolution mapping; mask/geometry spaces; debug image/API contract.
- **Acceptance criteria:** The engine proposes text-like regions from directional dark-to-light changes, scores candidates, identifies page and mask coordinate spaces, and leaves source assets unchanged; bubble detection remains a separate milestone.
- **Dependencies:** M04.

### M06 — OCR

- **Objective:** Recognize page text and support correction while treating recognition as a semantic proposal.
- **Inputs:** M02 image; M03 coordinate contracts; M01 AI/provider configuration policy.
- **Outputs:** Provider-neutral `OCRDocument` and correction contract; official PaddleOCR.js English PP-OCRv5 browser-worker adapter; validated text/confidence/provenance/polygons; editable review flow. Gemini OCR remains optional and is not on the core page-analysis path.
- **Affected packages:** `packages/image-engine`; `packages/ai`; `packages/shared`; `packages/core`; `apps/api`; `apps/web`.
- **Tests:** Valid/malformed schema; confidence range; polygon coordinate space; timeout/provider failure; manual edit/accept/reject; fake provider works without credentials.
- **Acceptance criteria:** OCR geometry is tied to the exact page space; model results remain proposals until accepted; invalid/low-confidence results are reviewable and cannot mutate project state.
- **Dependencies:** M03.

### M07 — Bubble detection

- **Objective:** Detect speech-bubble contour and tail candidates with deterministic geometry.
- **Inputs:** M02 page image; M03 spaces; optional M05 difference masks and M06 OCR observations.
- **Outputs:** `BubbleDetectionEngine` in `bubble-engine`; candidate contours/tails, confidence or quality metrics, algorithm version, review status.
- **Affected packages:** `packages/bubble-engine`; `packages/image-engine`; `packages/core`; `apps/api`; `apps/web`.
- **Tests:** Synthetic bubble contours/tails; scale/noise/irregularity; page bounds; declared-space checks; uncertain candidate handling.
- **Acceptance criteria:** Geometry is computed from each page rather than sample coordinates; each contour/tail carries its coordinate space; uncertain classifications are exposed for review.
- **Dependencies:** M03; M05 and M06 are optional inputs.

### M08 — Text/bubble association

- **Objective:** Associate recognized text observations with detected bubbles and allow user correction.
- **Inputs:** M06 accepted or reviewable OCR observations; M07 bubble candidates; M03 coordinate transforms.
- **Outputs:** Association proposals with text/bubble IDs, confidence, evidence/provenance, and accepted editable links.
- **Affected packages:** `packages/ai`; `packages/core`; `packages/bubble-engine`; `apps/api`; `apps/web`.
- **Tests:** Same-space and transformed geometry; ambiguous/multiple candidates; missing text/bubble; confidence/schema validation; user override.
- **Acceptance criteria:** Every accepted association references existing observations and bubble IDs; ambiguous associations remain pending; AI does not write accepted state directly.
- **Dependencies:** M06, M07.

### M09 — Caption safe region

- **Objective:** Compute a bubble interior and text-safe geometry that excludes contour/tail and existing text as configured.
- **Inputs:** M07 accepted bubble geometry; M08 text/bubble associations; M03 canonical page space.
- **Outputs:** `TextRegionEngine` safe polygons/masks and containment diagnostics in `bubble-engine`.
- **Affected packages:** `packages/bubble-engine`; `packages/shared`; `packages/core`; `apps/api`.
- **Tests:** Irregular shapes; text occupancy; mask/polygon containment; transforms; empty/impossible region; determinism.
- **Acceptance criteria:** Safe region is contained within the selected bubble interior, names canonical page space, and fails visibly if no usable region exists.
- **Dependencies:** M08, M03.

### M10 — Audio

- **Objective:** Import and inspect audio assets with an explicit audio timebase and deterministic time/sample conversions.
- **Inputs:** M01 app baseline; supported audio/container policy.
- **Outputs:** Audio import/status UI and API; `audio-engine` decoder metadata, duration, channel/sample-rate data, timebase and waveform reference.
- **Affected packages:** `apps/web`; `apps/api`; `packages/audio-engine`; `packages/shared`; `packages/core`.
- **Tests:** Supported and corrupt media; channel/rate metadata; sample↔time conversions and rounding; duration bounds; asset immutability.
- **Acceptance criteria:** Audio is a distinct project asset; every interval is tied to that asset's timebase and unit; no page geometry/time is conflated with audio time.
- **Dependencies:** M01.

### M11 — Transcription

- **Objective:** Produce timestamped transcript proposals and expose them for correction.
- **Inputs:** M10 audio/timebase; M01 AI service/provider boundary and fake adapter.
- **Outputs:** `TranscriptionService` port in `audio-engine`; transcription adapter in `ai`; segment/word proposals with confidence, provenance, and review UI.
- **Affected packages:** `packages/audio-engine`; `packages/ai`; `packages/core`; `apps/api`; `apps/web`.
- **Tests:** Time bounds/order/overlap; malformed/low-confidence outputs; provider timeout; no-credential fake path; edit/accept/reject.
- **Acceptance criteria:** Transcript segments remain proposals until reviewed; all times identify audio timebase; failed transcription leaves imported audio and app usable.
- **Dependencies:** M10; AI service boundary established in M06.

### M12 — Dialogue mapping

- **Objective:** Propose mappings between transcript dialogue, recognized comic text, reading order, and associated bubbles.
- **Inputs:** M08 accepted text/bubble links; M11 reviewed transcript; optional page reading order.
- **Outputs:** `DialogueMappingEngine` proposal contract; confidence/provenance/evidence; review and acceptance commands.
- **Affected packages:** `packages/ai`; `packages/core`; `apps/api`; `apps/web`.
- **Tests:** Ambiguous mappings; order constraints; missing input; stale source invalidation; schema/reference validation; user correction.
- **Acceptance criteria:** Accepted mapping resolves to valid transcript and bubble/text entities; ambiguity is visible; provider output cannot directly change project state.
- **Dependencies:** M08, M11.

### M13 — Caption fitting

- **Objective:** Fit approved dialogue deterministically into its linked bubble's safe region.
- **Inputs:** M09 safe region; M12 accepted dialogue mapping; approved font metrics and constraints.
- **Outputs:** `CaptionFittingEngine` line breaks, font sizing, canonical-page placement and fit diagnostics.
- **Affected packages:** `packages/caption-engine`; `packages/bubble-engine`; `packages/core`; `packages/shared`.
- **Tests:** Wrapping/font metrics; varied shapes; clipping/containment; fallback fonts; impossible fit; deterministic repeated fit.
- **Acceptance criteria:** Layout stays inside the chosen bubble safe region and names its coordinate space; impossible fits return actionable errors; no bottom subtitle layout mode exists.
- **Dependencies:** M09, M12.

### M14 — Timeline

- **Objective:** Build and edit dialogue cue intervals in the audio timebase, each referring to an accepted caption layout.
- **Inputs:** M10 audio timebase; M11 transcript timing; M12 dialogue mapping; M13 layouts.
- **Outputs:** `TimelineEngine` and cue model; validation for duration, overlap, ordering, references and edits.
- **Affected packages:** `packages/caption-engine`; `packages/audio-engine`; `packages/core`; `apps/api`.
- **Tests:** Cue boundaries/order; overlaps; frame/sample rounding; drift; manual edits; missing layout/bubble references.
- **Acceptance criteria:** Every active cue resolves to an approved layout and lies within audio duration; timing edits remain independent of page geometry.
- **Dependencies:** M10, M11, M12, M13.

### M15 — Live rendering

- **Objective:** Render the current page and approved caption into its bubble during audio playback/seek.
- **Inputs:** M13 layout; M14 timeline; M09 geometry; M10 audio playback position; M03 canonical page transform.
- **Outputs:** `RenderingEngine` live preview/compositing path; cue-to-render state updates; visible render errors.
- **Affected packages:** `packages/rendering`; `packages/core`; `packages/caption-engine`; `apps/api`; `apps/web`.
- **Tests:** Cue start/end transitions; seek/pause; geometry clipping; transform and viewport overlay; deterministic frame for fixed inputs/time; no bottom subtitle path.
- **Acceptance criteria:** At the playhead, caption appears inside the correct bubble and disappears outside its cue interval; renderer uses canonical page geometry, not viewport coordinates.
- **Dependencies:** M14, M13, M09.

### M16 — Editor

- **Objective:** Deliver the integrated editor flow for project setup, page analysis review, text/bubble association, caption inspection, and audio timeline control.
- **Inputs:** Completed user-facing capabilities M02–M15.
- **Outputs:** Coherent `apps/web` editor navigation, page workspace, review queues, caption inspector, timeline/transport, errors and progress states.
- **Affected packages:** `apps/web`; `apps/api`; relevant domain/engine public contracts.
- **Tests:** End-to-end edit/review flow using in-memory state; accessibility; viewport-to-page transform; stale revision/errors; reload behavior documented as transient before M17.
- **Acceptance criteria:** User can traverse the implemented workflow without dead controls; all model results are reviewable/editable; UI does not claim restart persistence before M17.
- **Dependencies:** M15 and all user-facing stages M02–M14.

### M17 — Persistence

- **Objective:** Persist projects, source assets, accepted edits, proposals, derived geometry, timeline, jobs, and artifact references safely.
- **Inputs:** M01–M16 in-memory domain behavior; storage/database choice recorded in `docs/decisions/`.
- **Outputs:** `apps/api` repository/asset-store adapters and migrations; content-addressed immutable source storage; revision transactions; project reopen/resume.
- **Affected packages:** `apps/api`; `packages/core`; `packages/shared`; `docs/decisions/`; integration tests.
- **Tests:** Migrations/round trips; process restart; transaction failure/outbox; asset integrity; stale revision; geometry/timebase serialization; user edits preserved on reanalysis.
- **Acceptance criteria:** Projects and source assets survive restart; edits/proposals remain separate; unknown schema versions fail safely; accepted state changes are transactional.
- **Dependencies:** M16; M03 schemas and all persisted entity contracts.

### M18 — PNG export

- **Objective:** Export a still PNG page with approved captions composited inside their selected bubbles.
- **Inputs:** M15 renderer; M17 durable project; selected page/time or approved static composition; explicit image settings.
- **Outputs:** PNG export job/artifact, settings/provenance metadata, download flow.
- **Affected packages:** `packages/rendering`; `apps/api`; `apps/web`; `packages/core`.
- **Tests:** Pixel/golden output; alpha/color profile policy; dimensions; safe-region clipping; missing font/assets; artifact persistence and revision reference.
- **Acceptance criteria:** PNG uses the shared deterministic compositor, preserves page dimensions unless explicitly configured, and contains no screen-bottom subtitle overlay.
- **Dependencies:** M17; live compositing from M15.

### M19 — MP4 export

- **Objective:** Export synchronized page/caption rendering and audio as MP4 using explicit encoding settings.
- **Inputs:** M14 timeline; M15 render path; M17 project/assets; selected frame rate, codec and audio settings.
- **Outputs:** Cancellable MP4 job; immutable artifact with renderer/settings/source revision; export status/download UI.
- **Affected packages:** `packages/rendering`; `apps/api`; `apps/web`; `packages/core`; `packages/audio-engine`.
- **Tests:** Codec/container integration; audio/video duration sync; cue/frame rounding; cancellation/failure cleanup; output metadata; no subtitle lane.
- **Acceptance criteria:** MP4 matches live preview within documented codec tolerance; captions remain in correct bubbles; timing/audio bounds pass preflight; source and project state survive export failure.
- **Dependencies:** M18 shared compositor; M17 persistence; M14 timeline.

### M20 — End-to-end coverage

- **Objective:** Verify the complete user journey from import through review, mapping, fitting, live playback, persistence, and both exports.
- **Inputs:** Implemented workflow M02–M19; synthetic or licensed fixtures with known geometry and timing.
- **Outputs:** `tests/e2e` browser/media workflow suite; fixture manifest/license notes; CI run tier and failure artifacts.
- **Affected packages:** `tests/e2e`; `tests/fixtures`; `apps/web`; `apps/api`; all integrated packages as test subjects.
- **Tests:** Full original+cleaned+audio scenario; manual correction path; restart/reopen; PNG/MP4 outputs; failure and retry path.
- **Acceptance criteria:** CI can reproduce the workflow without live AI credentials; assertions verify captions occupy the intended bubbles and synchronize to audio; fixtures declare coordinate spaces and tolerances.
- **Dependencies:** M19 and all prior functional milestones.

### M21 — Performance

- **Objective:** Measure and improve image, AI-job orchestration, timeline, preview, and export performance against explicit targets.
- **Inputs:** M20 representative fixtures and workflow; agreed page/audio/output sizes and target hardware.
- **Outputs:** Baseline benchmarks; profiling results; bounded memory/concurrency; caching keyed by input hash/options/version; documented service-level targets.
- **Affected packages:** `packages/image-engine`; `packages/bubble-engine`; `packages/caption-engine`; `packages/audio-engine`; `packages/rendering`; `packages/ai`; `apps/api`.
- **Tests:** Repeatable benchmark suite; peak memory; cold/warm cache; large-page/audio/export load; responsiveness under concurrent jobs; result equivalence after optimization.
- **Acceptance criteria:** Measured targets are documented and met or exceptions accepted; optimization preserves deterministic geometry and output correctness; no unbounded queues or buffers.
- **Dependencies:** M20.

### M22 — Security

- **Objective:** Review and harden upload, API, persistence, provider, job, and export boundaries.
- **Inputs:** M17 durable storage; M20 workflow tests; deployment/auth requirements and threat model.
- **Outputs:** Threat model and security decisions; upload/type/size protections; authorization/isolation; secret handling; safe logging/retention; dependency and configuration checks.
- **Affected packages:** `apps/api`; `apps/web`; `packages/ai`; `packages/shared`; `packages/rendering`; `scripts/`; docs.
- **Tests:** Auth/access-control cases; path/object isolation; malformed media/input fuzz cases; provider prompt/output validation; secret/log scan; dependency audit; export access checks.
- **Acceptance criteria:** Threats and mitigations are documented; unauthorized project/media access is rejected; untrusted AI/media outputs cannot bypass schemas or mutate project state; no secrets appear in source, logs, or artifacts.
- **Dependencies:** M17, M20; deployment requirements must be defined before final acceptance.

### M23 — Final review

- **Objective:** Confirm product, architecture, quality, and release readiness against the approved requirements.
- **Inputs:** M01–M22 deliverables; acceptance evidence; unresolved issue list.
- **Outputs:** Final review report; release checklist; known limitations; architecture/decision docs updated to match actual implementation; prioritized follow-up items.
- **Affected packages:** Repository-wide; `docs/`; `README.md`.
- **Tests:** Full required CI suite; clean install/build; e2e exports; security/performance gate review; manual UX review on supported browsers/devices.
- **Acceptance criteria:** Every milestone gate has evidence; captions render only in selected bubbles; coordinate/timebase invariants hold end-to-end; no misleading unfinished controls; blockers are resolved or explicitly accepted by project owner.
- **Dependencies:** M21, M22, M20.

## Cross-milestone gates

- Every milestone adds focused tests and keeps the root start/check path working.
- Default CI uses deterministic fake AI providers; network/vendor credentials are
  not required for ordinary development or tests.
- Reanalysis invalidates dependent outputs by input/revision hash while retaining
  prior proposals and manual edits for review.
- Every AI result has schema/version, confidence, provenance and source hashes;
  only validated application commands can accept it into canonical state.
- Every image geometry value identifies its coordinate space and revision;
  every audio timestamp identifies its timebase and unit.
- No milestone may introduce a conventional bottom-of-screen subtitle lane.
- User-visible controls are enabled only when their capability is implemented;
  otherwise the state is clearly unavailable or omitted.
