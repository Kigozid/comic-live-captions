# Comic Captioner — System Architecture

**Status:** proposed target architecture; not a description of implemented code.

## Scope and guiding constraints

Comic Captioner aligns dialogue in audio to the correct speech bubbles on a
comic page, fits captions to those bubbles, synchronizes them to audio, and
exports the composed result. It is not a conventional subtitle system: no
caption is placed in a bottom-of-screen subtitle track. Geometry, layout,
timing, and rendering are deterministic and inspectable. AI proposes semantic
interpretations; validated proposals are reviewed and applied through the
application service, never directly to project state.

The local workspace currently contains `AGENTS.md` and design documents, but no
source files, dependency manifests, tests, or Git metadata. The target layout
below follows the `comic-captioner/` tree supplied for this design; it is not
evidence that a GitHub checkout or these packages currently exist. The
interfaces use TypeScript-like notation without selecting a runtime or
framework.

## Proposed repository layout

```text
comic-captioner/
├── apps/web/                 # editor and review workflows
├── apps/api/                 # application composition, API, jobs, persistence
├── packages/
│   ├── core/                 # domain model, ProjectService, application ports
│   ├── image-engine/         # image operations, alignment, OCR port
│   ├── bubble-engine/        # bubble geometry and safe/text regions
│   ├── caption-engine/       # fitting and timeline
│   ├── audio-engine/         # audio, timebase, transcription port
│   ├── ai/                   # AIService and semantic/provider adapters
│   ├── rendering/            # deterministic preview and export
│   └── shared/               # cross-package schemas and low-level primitives
├── tests/{unit,integration,fixtures,e2e}/
├── docs/{architecture.md,pipeline.md,decisions/}
├── scripts/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

This is a proposed monorepo layout based on the user's supplied tree.

## 1. System architecture

Use a modular application with a thin UI, an application/service layer that
owns use cases and validation, domain models that express project state and
invariants, and replaceable infrastructure adapters for image algorithms,
AI vendors, media codecs, and storage. Early deployments can run these as
modules in one process. Keep contracts suitable for later process separation;
do not introduce network services until scale or isolation requires them.

```text
Frontend (project editor, review, timeline, export)
                 │ commands / queries / events
                 ▼
Application layer: ProjectService, workflow orchestration, validation
     ┌───────────┼─────────────────┐
     ▼           ▼                 ▼
Domain       Image/media        AI adapter boundary
models       engines/services   AIService + providers
     └───────────┼─────────────────┘
                 ▼
 Persistence ports: database metadata + immutable asset/object storage
                 │
                 ▼
 Export renderer / encoded media artifact
```

The dependency direction points inward: adapters implement ports declared by
the application/domain-facing contracts. Domain rules must not depend on a
specific UI framework, image library, AI provider, database, or codec.

## 2. Package boundaries

Suggested workspace packages (or equivalent source-level modules):

| Package                   | Owns                                                                                                              | Must not own                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/shared`         | Cross-package schemas, IDs and low-level primitives                                                               | Domain policy or orchestration           |
| `packages/core`           | Project aggregate, invariants, coordinate/time values, `ProjectService`, use cases, repository/engine ports       | Pixel algorithms, provider SDKs, UI      |
| `packages/image-engine`   | Image decode/normalization, pyramids, comparison, masks, alignment, OCR port/types                                | Bubble semantics, project persistence    |
| `packages/bubble-engine`  | Bubble contours/tails, candidate geometry, `TextRegionEngine`, interior and safe-region derivation                | Project mutation, provider SDKs          |
| `packages/caption-engine` | Shape-aware fitting, wrapping, font constraints, `TimelineEngine` and timeline model                              | Page registration, media encoding        |
| `packages/audio-engine`   | Audio decode/waveform/timebase and transcription port/types                                                       | Page geometry                            |
| `packages/ai`             | `AIService`, semantic/provider adapters for OCR, classification, and dialogue mapping; schemas, retry, provenance | Core project state writes                |
| `packages/rendering`      | Deterministic compositing, preview frames and export via `RenderingEngine`                                        | Semantic inference or persistent edits   |
| `apps/api`                | Composition root, transport/auth, job workers, persistence adapters/migrations, `ProjectService` wiring           | Duplicating domain rules in handlers     |
| `apps/web`                | Editor, inspector, timeline controls, review flows and transient client state                                     | Canonical geometry or direct persistence |
| `tests/`                  | Unit, integration, e2e suites and shared synthetic/licensed fixtures                                              | Production runtime code                  |
| `scripts/`                | Development, CI, migration and fixture tasks                                                                      | Product/domain behavior                  |

`apps/api` is the composition root and wires implementations, repositories,
auth, jobs and transport. A practical dependency direction is
`shared ← core ← engines/ai/rendering ← apps/api`; `apps/web` consumes public
contracts and never imports server implementation modules. Avoid cycles and
have engines return immutable values for core/application validation and
commit. Keep `OCRService` as a capability port in `image-engine`. The
implemented comic-page OCR adapter is the official `@paddleocr/paddleocr-js`
browser SDK running English PP-OCRv5 in a cached Web Worker; its result is
validated by the API before bubble association. Gemini OCR remains an optional
provider adapter and is not used by normal page analysis or speech automation.
OCR is text recognition, not bubble geometry.
`DialogueMappingEngine` is likewise an AI-backed proposal adapter behind a
core-owned port. The supplied package list has no standalone alignment,
text-region, timeline, or persistence package, so place alignment in
`image-engine`, text regions in `bubble-engine`, timeline in `caption-engine`,
and persistence adapters in `apps/api` until independent reuse warrants
extraction. Put wire schemas in `shared`; keep invariants in `core`.

## 3. Frontend architecture

`apps/web` is a client of application use cases, not the owner of canonical
geometry or workflow rules. Organize screens/components around project tasks:

- **Project setup:** source/cleaned page pairs, audio, page and asset status.
- **Page workspace:** original/cleaned comparison, alignment overlay, bubble
  and text/safe-region overlays, with visibility and confidence controls.
- **Review queues:** OCR corrections, bubble classification, transcription,
  dialogue-to-bubble mapping; show confidence, provenance, and editable values.
- **Timeline:** audio transport/waveform and dialogue segments linked to
  bubble placements. The timeline controls when a bubble caption appears; it
  does not create a screen-bottom subtitle lane.
- **Caption inspector:** selected dialogue, selected bubble, fitted lines,
  font/placement controls, fit warnings, and manual adjustment where allowed.
- **Export:** target settings, validation errors, progress, and output artifact.

Use a normalized client cache keyed by project/entity IDs, plus transient UI
state for selection, zoom, pan, panels, and playback. Persist edits through
explicit commands with expected project revision. Render overlays from
canonical geometry using a shared coordinate-to-viewport transform; do not
write viewport coordinates back as page geometry. Optimistic changes must be
reconciled against validated server/application responses. Surface stale
revision conflicts rather than silently overwriting edits.

## 4. Backend architecture

`packages/core` defines application commands and queries such as import assets,
register pages, analyze text, detect bubbles, generate transcription, propose
dialogue mappings, approve/edit results, fit captions, edit timeline, preview,
and export. Each command validates IDs, coordinate spaces, revisions, and
prerequisites, invokes ports, then atomically persists domain state and an
outbox/event record. Long-running analyses and exports use jobs with explicit
states (`queued`, `running`, `succeeded`, `failed`, `cancelled`) and progress;
job output is a proposal/artifact until an application command accepts it.

Infrastructure adapters may run synchronously or in workers. Keep media
decoding and large image buffers in bounded worker processes where useful.
Retries are safe only for idempotent jobs; assign job IDs and input hashes.
Authorization, quotas, provider secrets, and logging belong at the `apps/api`
boundary, not in domain entities. Persistence implementations/migrations start
in `apps/api` and implement repository and asset-store ports from `core`.

## 5. State model

The project is the aggregate root for accepted state. Large binary assets,
analysis jobs, and export outputs are referenced by IDs and managed by
separate repositories. Mutations increment a project revision and record the
actor/time plus source provenance. Core conceptual entities:

- `Project`: id, schema version, revision, pages, audio assets, workflow state.
- `Page`: original and cleaned `ImageAssetRef`s, canonical page space,
  registration result, analysis revisions.
- `ImageAsset`: immutable bytes/ref, dimensions, color profile, orientation,
  content hash.
- `CoordinateSpace`: discriminated identity describing asset/page/frame or
  normalized space, dimensions, origin, axes, pixel-center convention, and
  parent transform when applicable.
- `Transform`: directed mapping from a named source space to a named target
  space, matrix/model, validity domain, residual/error metrics and provenance.
- `TextObservation`: OCR text and polygon, language, confidence, source model,
  and coordinate-space ID; editable accepted text is separately represented.
- `Bubble`: stable ID, contour/tail geometry and classification in a named
  space; links to candidate source observations and review status.
- `TextRegion`: bubble interior, occupied-text mask, safe polygon/mask, all
  tagged with the coordinate space and geometry revision they use.
- `AudioAsset` / `TranscriptSegment`: immutable media ref and transcript text,
  confidence, speaker metadata if available, and time interval in audio time.
- `DialogueLink`: transcript/OCR relationship to a page bubble with confidence,
  rationale/provenance, review status, and user edits.
- `CaptionLayout`: chosen bubble ID, fitted text runs/lines, font metrics,
  placement geometry and fit diagnostics in the bubble's page coordinate space.
- `TimelineCue`: dialogue/layout IDs and start/end in the audio timebase.
- `AnalysisProposal`: typed, schema-versioned, confidence-scored result with
  input hashes, engine/provider/version, coordinate-space references, and
  review status. It is separate from accepted project state.
- `ExportArtifact`: immutable output ref, settings, source revision, and
  renderer version.

Use explicit states for project workflow (assets ready, geometry pending or
reviewed, semantic review pending, layout review pending, exportable) derived
from entity/job state rather than a single fragile linear stage. Re-running an
upstream stage invalidates dependent derived results by input/revision hash;
preserve prior approved user edits for review/migration instead of silently
discarding them.

## 6. Image-processing pipeline

### Coordinate contract

Every image geometry object carries a complete concrete coordinate-space
definition. The M03 contract below supersedes earlier shorthand names such as
asset-pixel, page-pixel, normalized-page, and viewport space. A naked `{x,y}`,
polygon, mask, box, or transform without a declared space is invalid at API and
persistence boundaries. Original-page ImageSpace is the canonical page space
for its geometry revision; cleaned-image geometry uses its own ImageSpace and
will require an explicit transform before being combined with canonical page
geometry. A mask on a distinct sampling grid must use a distinct raster-space
ID and explicit mapping, never be silently treated as page pixels.

Transforms name both endpoints and direction: `sourceSpaceId → targetSpaceId`.
Use homogeneous 3×3 matrices for affine transforms; use a typed warp field for
nonlinear registration. Record resampling convention, invertibility (if
known), inlier/error metrics, and valid image domain. Transform polygons by
transforming edges adaptively when nonlinear warps are used. Reject geometry
whose space cannot be resolved or whose page/geometry revision is stale.

### Ordered processing

1. Decode source assets, apply orientation, inspect dimensions/profile, hash,
   and create immutable asset-space definitions.
2. Build deterministic image pyramids and normalization artifacts without
   modifying source assets.
3. Estimate cleaned-to-original registration; return a candidate transform
   and diagnostics. Review/accept it before dependent merged geometry is
   treated as canonical.
4. Warp/resample cleaned page into canonical page space under an explicit
   sampling policy; produce pixel-difference maps and masks in declared spaces.
5. Obtain OCR text observations; retain source polygons in their original
   coordinate spaces and convert through registration when needed.
6. Detect bubble contours and tails deterministically; ambiguous semantic
   classes may be reviewed with AI-assisted proposals.
7. Compute bubble interior, observed text occupancy and caption-safe regions.
   Keep masks/polygons with explicit space and algorithm/version metadata.
8. Fit approved caption text inside its linked safe region and produce layout
   diagnostics; no fitting routine chooses a bubble by semantic guess.

## 7. AI pipeline

`AIService` is the single application-facing boundary for semantic model
requests. It receives a typed task, bounded input references/features, schema
version, and cancellation/deadline options; it returns raw provider output
wrapped with provider/model/version, token/usage metadata where available,
input hash, and trace ID. A validator parses output into a task-specific schema,
checks IDs and coordinate-space references, checks confidence bounds, and
rejects malformed or out-of-scope geometry. Any model-produced geometry must
name its coordinate space and be transformed/validated by deterministic code.

Store valid outputs as immutable `AnalysisProposal`s, not direct project
mutations. Present confidence, evidence, and provenance for manual review. A
user/application command accepts or edits a proposal, revalidates it against
the current revision, then commits through `ProjectService`. Low confidence,
schema failure, mismatch, or provider error routes to retry/manual review, not
silent acceptance. Provider adapters are replaceable and tests use deterministic
fakes. Do not send unnecessary assets or credentials to providers.

## 8. Audio pipeline

Audio is its own asset and time domain. Decode/read metadata, retain immutable
source bytes, and record sample rate, channel layout, duration, codec, and any
derived waveform/feature artifact. Every time interval uses an explicit
timebase (`audio:<assetId>` with seconds or integer sample ticks); never mix
wall clock, video frame index, and audio samples without a conversion.

Transcription yields timestamped segment proposals and optional word-level
timings, language, speaker labels, confidence, and provenance. Validate
monotonicity, duration bounds, and any overlap policy. Dialogue mapping relates
segments to OCR text and bubble IDs using semantic proposals plus deterministic
constraints (page order, timing/order consistency, uniqueness rules only when
configured). Ambiguous links remain unresolved for review. Timeline edits are
user/domain actions; model timing is a proposal. Convert between samples,
seconds, and export frame ticks using explicit rational rates and documented
rounding to avoid drift.

## 9. Rendering pipeline

Rendering consumes a frozen, validated project revision: canonical page raster,
accepted registration/geometry, approved text and dialogue links, accepted
caption layouts, timeline, fonts/assets, and output settings. The renderer
composites glyph runs only within their selected bubble-safe geometry using
deterministic clipping, alpha/blending, font measurement, and documented color
management. It generates previews/frames from audio-time cues and encodes the
requested output. No renderer path may emit a bottom subtitle lane.

Preview and export share the same layout/compositing implementation. Export
records all inputs, versions, settings, and revision; output is immutable.
Validate that every active cue resolves to a layout and bubble, fit constraints
hold, all geometry maps into the page space, cue times lie within audio bounds,
and no unsupported/missing fonts or assets remain. Determinism means identical
inputs/settings/version yield equivalent frames; codecs may prevent bytewise
identical files and that limitation is recorded.

## 10. Persistence model

Persist metadata and relationships in a transactional database; persist original
and derived large binaries in content-addressed object/file storage behind an
asset-store port. Store immutable source assets separately from versioned
derived artifacts. Suggested logical tables/collections: projects, pages,
assets, coordinate spaces, transforms, OCR observations/edits, bubbles,
regions, audio tracks, transcript segments, dialogue links, caption layouts,
timeline cues, proposals, jobs, export artifacts, and revision/event records.

Use stable IDs, schema versions, foreign-key integrity, and project revision
checks. Geometry serialization always includes coordinate-space ID, type,
precision, and page geometry revision. Persist transform direction and model.
Store AI inputs/outputs subject to retention/privacy policy; keep secrets out of
records. Derived caches are keyed by source hashes + parameters + engine
version and may be rebuilt. Use transactional outbox/job records so state
changes and queued work cannot diverge. Migrations must preserve user-edited
and approved state, and unknown schema versions fail safely.

## 11. Testing architecture

- **Domain unit tests:** invariants, revision conflicts, state transitions,
  proposal acceptance, explicit coordinate-space requirements, and timebase
  conversions.
- **Geometry/property tests:** transform round trips within tolerance, bounds,
  affine composition/inversion, polygon containment, mask sampling, and
  non-linear warp edge handling. Fixtures declare image dimensions and spaces.
- **Algorithm tests:** registration on synthetic known transforms, difference
  masks, bubble contours, safe-region containment, font fitting/wrapping, and
  deterministic output. Include varied sizes, rotations, noise, and failures;
  never rely solely on hard-coded comic coordinates.
- **Contract tests:** schema validation, malformed AI outputs, confidence
  ranges, coordinate-space mismatch, adapter compatibility, and serialization
  versioning.
- **AI adapter tests:** provider-independent fake responses, timeout/retry,
  refusal/error paths, provenance, and proof that a response cannot directly
  mutate project state.
- **Audio/timeline tests:** sample/time conversion, timestamp bounds, overlap,
  drift/rounding, segment edits, and dialogue-link constraints.
- **Rendering tests:** golden images for carefully versioned fixtures,
  determinism, clipping to safe regions, no screen-bottom subtitle path, cue
  activation boundaries, and export validation.
- **Persistence tests:** migrations, transactional updates/outbox, asset hash
  integrity, stale revision rejection, and round-trip of all geometry spaces.
- **Application integration tests:** full workflow through fake engines and
  in-memory repositories; verify review gates and invalidation after upstream
  changes.
- **Frontend tests:** component behavior, coordinate overlay conversion,
  accessibility, client/server revision conflict handling, and user review/edit
  flows.
- **End-to-end tests:** import paired pages/audio, review analysis, map dialogue,
  fit and synchronize captions inside bubbles, preview/export, and reopen the
  project. Use synthetic or licensed fixtures with known expected geometry.

Keep fast unit/contract tests in the default change loop and run integration,
visual regression, and codec/export tests in CI tiers appropriate to their cost.
Record tolerances and fixture licenses. There is no existing test runner or
build to prescribe because this workspace has no implementation or dependency
manifest. The proposed shared test tree is `tests/{unit,integration,fixtures,e2e}`.

## Service and engine interface contracts

The following signatures are illustrative language-neutral/TypeScript-like
contracts. All methods return immutable results or typed errors, accept a
cancellation/deadline context, and include trace/provenance metadata where
relevant. Request schemas must be versioned at persisted or process boundaries.

### Shared primitives

```ts
type Id = string;
type Confidence = number; // finite value in [0, 1]
type CoordinateSpaceKind =
  'image' | 'display' | 'canvas' | 'normalized' | 'export' | 'mask';
type CoordinateSpaceRef = { id: Id; kind: CoordinateSpaceKind };
type Point<S extends CoordinateSpaceRef> = {
  x: number;
  y: number;
  coordinateSpace: S;
};
type Polygon<S extends CoordinateSpaceRef> = {
  points: Point<S>[];
  coordinateSpace: S;
};
type Matrix3x3 = {
  rows: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
};
type Transform = {
  id: Id;
  sourceSpace: CoordinateSpaceRef;
  targetSpace: CoordinateSpaceRef;
  model: 'affine' | 'projective' | 'warp-field';
  matrix?: Matrix3x3;
  error?: { metric: string; value: number; unit: string };
  validDomain: Polygon;
  algorithmVersion: string;
};
type Proposal<T> = {
  id: Id;
  schemaVersion: number;
  value: T;
  confidence: Confidence;
  inputHashes: string[];
  provenance: { engine: string; version: string; provider?: string };
  status: 'pending-review' | 'accepted' | 'edited' | 'rejected';
};
type Result<T> = { value: T; warnings: string[]; traceId: string };
```

#### Coordinate-space contract (M03)

All spaces use a top-left origin, with x increasing right and y increasing down.
Raster spaces address pixel centers at integer coordinates; the image extent is
`[-0.5, width - 0.5] × [-0.5, height - 0.5]`. This keeps resampling and edge
mapping unambiguous. Normalized space measures from image edges, so its full
extent is `[0, 1] × [0, 1]`. Geometry is immutable and carries its concrete
space object (ID, kind, and required metadata); it may not be retagged by a
consumer.

- **ImageSpace**: source or canonical page raster pixels and image dimensions.
  Original-page pixels are the canonical page space after image import.
- **DisplaySpace**: CSS pixels for one image in one viewport. It references its
  ImageSpace and records viewport dimensions, centered image-edge origin,
  user pan in CSS pixels, fit scale, and zoom. It is transient and is never
  persisted as page geometry.
- **CanvasSpace**: physical backing-store pixels, with an explicit associated
  DisplaySpace and device-pixel ratio (DPR). Display-to-canvas conversion is
  `(p + 0.5) * DPR - 0.5`; its inverse is `(p + 0.5) / DPR - 0.5`.
- **NormalizedSpace**: unit-square edge-relative coordinates tied to exactly
  one ImageSpace. Image-to-normalized conversion is `(p + 0.5) / dimension`;
  its inverse is `p * dimension - 0.5`.
- **ExportSpace**: output raster pixel centers tied to one ImageSpace and
  explicit output dimensions. It scales the image extent independently on x
  and y: `(p + 0.5) * outputDimension / inputDimension - 0.5`. Aspect-ratio
  policy is chosen by export settings before this transform.
- **MaskSpace**: a binary raster grid tied to one ImageSpace, with its own
  dimensions and explicit per-axis pixel-center scale back to that image.
  Region masks may be cropped and run-length encoded; each crop declares its
  origin in the full MaskSpace. A region polygon and bounding box remain in
  the referenced ImageSpace.

Image-to-display uses `origin + pan + (image + 0.5) * fitScale * zoom - 0.5`;
display-to-image is the exact inverse. All conversions validate declared
space IDs and kinds, and reject invalid dimensions/scales. Polygons, bounds,
contours, tails, safe regions, text observations, and caption placements carry
their coordinate-space declaration. Persisted page geometry is always in
ImageSpace; display and canvas coordinates are only for interaction/rendering.
A raster mask on a different sampling grid uses MaskSpace and declares its
mapping to the ImageSpace rather than silently treating mask indices as page
pixels.

In concrete code, polygon holes/rings, masks, bounds and typed errors should be
fully specified. `coordinateSpace` is required for every geometric value,
including transform domains and algorithm outputs.

### Interfaces

```ts
interface ImageEngine {
  inspect(
    input: { asset: ImageAssetRef },
    ctx: CallContext,
  ): Promise<Result<ImageDescriptor>>;
  normalize(
    input: { asset: ImageAssetRef; policy: ImageNormalizationPolicy },
    ctx: CallContext,
  ): Promise<Result<NormalizedImageRef>>;
  compare(
    input: { a: ImageRef; b: ImageRef; transform?: TransformRef },
    ctx: CallContext,
  ): Promise<Result<PixelDifferenceMapRef>>;
  warp(
    input: {
      image: ImageRef;
      transform: TransformRef;
      target: CoordinateSpaceRef;
      sampling: SamplingPolicy;
    },
    ctx: CallContext,
  ): Promise<Result<DerivedImageRef>>;
  createPyramid(
    input: { image: ImageRef; levels: number },
    ctx: CallContext,
  ): Promise<Result<ImagePyramidRef>>;
}

interface AlignmentEngine {
  estimate(
    input: {
      source: ImageRef;
      target: ImageRef;
      sourceSpace: CoordinateSpaceRef;
      targetSpace: CoordinateSpaceRef;
      constraints?: AlignmentConstraints;
    },
    ctx: CallContext,
  ): Promise<Result<Proposal<Transform>>>;
  validate(
    input: { transform: Transform; correspondences?: PointCorrespondence[] },
    ctx: CallContext,
  ): Promise<Result<AlignmentQuality>>;
}

interface OCRService {
  recognize(
    input: {
      image: ImageRef;
      coordinateSpace: CoordinateSpaceRef;
      region?: Polygon;
      languages?: string[];
    },
    ctx: CallContext,
  ): Promise<Result<Proposal<OCRObservation[]>[]>>;
}

interface BubbleDetectionEngine {
  detect(
    input: {
      image: ImageRef;
      coordinateSpace: CoordinateSpaceRef;
      textObservations?: OCRObservation[];
      differenceMask?: MaskRef;
    },
    ctx: CallContext,
  ): Promise<Result<Proposal<BubbleCandidate>[]>>;
}

interface TextRegionEngine {
  derive(
    input: {
      bubble: BubbleGeometry;
      textObservations: OCRObservation[];
      image: ImageRef;
      options: SafeRegionOptions;
    },
    ctx: CallContext,
  ): Promise<Result<TextRegionGeometry>>;
  validate(
    input: { bubble: BubbleGeometry; region: TextRegionGeometry },
    ctx: CallContext,
  ): Promise<Result<GeometryValidation>>;
}

interface TranscriptionService {
  transcribe(
    input: {
      audio: AudioAssetRef;
      language?: string;
      granularity: 'segment' | 'word';
    },
    ctx: CallContext,
  ): Promise<Result<Proposal<TranscriptSegment[]>[]>>;
}

interface DialogueMappingEngine {
  propose(
    input: {
      pageText: OCRObservation[];
      transcript: TranscriptSegment[];
      bubbles: BubbleGeometry[];
      readingOrder?: Id[];
    },
    ctx: CallContext,
  ): Promise<Result<Proposal<DialogueLinkCandidate[]>[]>>;
}

interface CaptionFittingEngine {
  fit(
    input: {
      text: string;
      bubbleId: Id;
      safeRegion: TextRegionGeometry;
      font: FontSpec;
      constraints: FitConstraints;
      coordinateSpace: CoordinateSpaceRef;
    },
    ctx: CallContext,
  ): Promise<Result<CaptionLayoutResult>>;
}

interface TimelineEngine {
  build(
    input: {
      links: AcceptedDialogueLink[];
      transcript: TranscriptSegment[];
      audioTimebase: AudioTimebase;
      edits?: TimelineEdit[];
    },
    ctx: CallContext,
  ): Promise<Result<Timeline>>;
  validate(
    input: {
      timeline: Timeline;
      layouts: CaptionLayout[];
      audioDuration: AudioTime;
    },
    ctx: CallContext,
  ): Promise<Result<TimelineValidation>>;
}

interface RenderingEngine {
  preview(
    input: { snapshot: RenderSnapshot; at: AudioTime },
    ctx: CallContext,
  ): Promise<Result<RenderedFrame>>;
  export(
    input: { snapshot: RenderSnapshot; settings: ExportSettings },
    ctx: CallContext,
  ): Promise<Result<ExportJobRef>>;
}

interface ProjectService {
  create(
    input: CreateProjectCommand,
    ctx: CallContext,
  ): Promise<Result<ProjectSnapshot>>;
  importAssets(
    input: ImportAssetsCommand,
    ctx: CallContext,
  ): Promise<Result<ProjectSnapshot>>;
  query(
    input: ProjectQuery,
    ctx: CallContext,
  ): Promise<Result<ProjectSnapshot>>;
  acceptProposal(
    input: { projectId: Id; proposalId: Id; expectedRevision: number },
    ctx: CallContext,
  ): Promise<Result<ProjectSnapshot>>;
  edit(
    input: ProjectEditCommand & { expectedRevision: number },
    ctx: CallContext,
  ): Promise<Result<ProjectSnapshot>>;
  enqueue(
    input: ProjectAnalysisCommand,
    ctx: CallContext,
  ): Promise<Result<JobRef>>;
  createRenderSnapshot(
    input: { projectId: Id; expectedRevision: number },
    ctx: CallContext,
  ): Promise<Result<RenderSnapshot>>;
}

interface AIService {
  propose<T>(
    input: {
      task:
        | 'comic-understanding'
        | 'bubble-classification'
        | 'dialogue-semantics'
        | 'dialogue-mapping';
      schema: SchemaRef<T>;
      payload: BoundedSemanticInput;
      coordinateSpaces: CoordinateSpaceRef[];
      providerPolicy?: ProviderPolicy;
    },
    ctx: CallContext,
  ): Promise<Result<Proposal<T>>>;
}
```

`OCRService` and `TranscriptionService` use replaceable adapters and return
typed observations/proposals through these same review rules. Comic-page OCR
runs locally with PaddleOCR; audio transcription may use a server-side AI
provider. Keep
semantic providers behind `AIService`; deterministic `AlignmentEngine`,
`BubbleDetectionEngine` geometry, `TextRegionEngine`, fitting, timeline, and
renderer implementations do not call semantic providers. `ProjectService` is
the only interface above that accepts mutations to canonical project state.

### Minimum cross-interface guarantees

- All page-image inputs and outputs identify their coordinate space; all time
  values identify their timebase and unit.
- Engines do not mutate caller inputs or persistent project state.
- Proposal results include confidence, schema, input hashes, engine/version,
  and review status; deterministic geometry includes algorithm/version and
  quality metrics.
- Invalid geometry, unmappable coordinate spaces, stale revisions, malformed
  schema, and out-of-range time values are typed failures, not silent repairs.
- `ProjectService` checks prerequisites and revision, validates results, and
  commits accepted edits atomically. UI/provider callbacks cannot bypass it.
- Long-running calls expose job status/cancellation and are idempotent or use
  deduplication keys based on inputs and options.
