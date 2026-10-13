export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type ProjectId = Brand<string, 'ProjectId'>;
export type PageId = Brand<string, 'PageId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type BubbleId = Brand<string, 'BubbleId'>;
export type ProposalId = Brand<string, 'ProposalId'>;
export type AudioTimebaseId = Brand<string, 'AudioTimebaseId'>;
export type CoordinateSpaceId = Brand<string, 'CoordinateSpaceId'>;

export type Confidence = number;

/**
 * Geometry convention: image, canvas, and export pixel centers are integer
 * coordinates; image edges are therefore at -0.5 and size - 0.5. Display
 * coordinates are CSS-pixel centers. Normalized coordinates describe image
 * edges, so the top-left and bottom-right edges are (0, 0) and (1, 1).
 * Every space uses a top-left origin with x right and y down.
 */
export type CoordinateSpaceKind =
  'image' | 'display' | 'canvas' | 'normalized' | 'export' | 'mask';

export interface CoordinateSpaceRef {
  readonly id: CoordinateSpaceId;
  readonly kind: CoordinateSpaceKind;
}

export interface ImageSpace extends CoordinateSpaceRef {
  readonly kind: 'image';
  readonly dimensions: ImageDimensions;
}

export interface DisplaySpace extends CoordinateSpaceRef {
  readonly kind: 'display';
  readonly dimensions: ImageDimensions;
  readonly imageSpaceId: CoordinateSpaceId;
  /** CSS-pixel edge location of the image's top-left edge before pan. */
  readonly origin: Readonly<{ x: number; y: number }>;
  /** User pan in CSS pixels. */
  readonly pan: Readonly<{ x: number; y: number }>;
  readonly fitScale: number;
  readonly zoom: number;
}

export interface CanvasSpace extends CoordinateSpaceRef {
  readonly kind: 'canvas';
  /** Physical backing-store dimensions. */
  readonly dimensions: ImageDimensions;
  readonly displaySpaceId: CoordinateSpaceId;
  readonly devicePixelRatio: number;
}

export interface NormalizedSpace extends CoordinateSpaceRef {
  readonly kind: 'normalized';
  readonly imageSpaceId: CoordinateSpaceId;
}

export interface ExportSpace extends CoordinateSpaceRef {
  readonly kind: 'export';
  readonly dimensions: ImageDimensions;
  readonly imageSpaceId: CoordinateSpaceId;
}

/** A downsampled binary raster with an explicit center-to-center page mapping. */
export interface MaskSpace extends CoordinateSpaceRef {
  readonly kind: 'mask';
  readonly dimensions: ImageDimensions;
  readonly imageSpaceId: CoordinateSpaceId;
  readonly maskToImageScaleX: number;
  readonly maskToImageScaleY: number;
}

export interface MaskRun {
  /** Row and horizontal span are local to the mask crop. */
  readonly y: number;
  readonly x: number;
  readonly length: number;
}

export interface BinaryMask {
  readonly width: number;
  readonly height: number;
  readonly runs: readonly MaskRun[];
  /** Pixel-center location of the crop origin in the full MaskSpace. */
  readonly origin: Point<MaskSpace>;
  readonly coordinateSpace: MaskSpace;
}

export interface TextRegion {
  readonly id: string;
  readonly mask: BinaryMask;
  readonly polygon: Polygon<ImageSpace>;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly confidence: number;
  readonly coordinateSpace: ImageSpace;
}

/** Text-removal region localized on the original comic page. */
export type OriginalTextRegion = TextRegion;

/** Provider-neutral OCR output. OCR boxes use image-space pixel-edge bounds. */
export interface OCRWord {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly confidence: Confidence;
  readonly coordinateSpace: ImageSpace;
}

export interface OCRLine {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly confidence: Confidence;
  readonly coordinateSpace: ImageSpace;
  readonly words: readonly OCRWord[];
}

export interface OCRBlock {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly confidence: Confidence;
  readonly coordinateSpace: ImageSpace;
  readonly lines: readonly OCRLine[];
}

export interface OCRDocument {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly confidence: Confidence;
  readonly coordinateSpace: ImageSpace;
  readonly blocks: readonly OCRBlock[];
  readonly revision: number;
  readonly reviewStatus: ReviewStatus;
  readonly provenance: Provenance;
}

export type OCRItemKind = 'document' | 'block' | 'line' | 'word';

/** A correction targets one OCR node; coordinates stay in its original ImageSpace. */
export interface OCRCorrection {
  readonly targetKind: OCRItemKind;
  readonly targetId: string;
  readonly text?: string;
  readonly boundingBox?: Bounds<ImageSpace>;
}

export interface AffineMatrix {
  /** Row-major 2D affine transform: x'=m0*x+m1*y+m2, y'=m3*x+m4*y+m5. */
  readonly values: readonly [number, number, number, number, number, number];
}

export interface AlignmentTranslation {
  readonly x: number;
  readonly y: number;
  readonly coordinateSpace: ImageSpace;
}

/** Maps cleaned source-image pixel centers into original target-image pixels. */
export interface AlignmentResult {
  readonly sourceSpace: ImageSpace;
  readonly targetSpace: ImageSpace;
  /** Uniform scale mapping cleaned source-image pixels to original pixels. */
  readonly scale: number;
  /** Clockwise radians under the top-left, +y-down convention. */
  readonly rotation: number;
  readonly translation: AlignmentTranslation;
  /** Normalized correlation confidence in [0, 1]. */
  readonly confidence: number;
  readonly transformMatrix: AffineMatrix;
  readonly method: 'automatic' | 'manual';
  readonly algorithmVersion: string;
}

export interface AlignmentParameters {
  readonly scale: number;
  readonly rotation: number;
  readonly translationX: number;
  readonly translationY: number;
}

export interface CoordinateSpaceOptions {
  readonly id: string;
  readonly dimensions: ImageDimensions;
}

export interface DisplaySpaceOptions extends CoordinateSpaceOptions {
  readonly imageSpace: ImageSpace;
  readonly origin?: { readonly x: number; readonly y: number };
  readonly pan?: { readonly x: number; readonly y: number };
  readonly fitScale?: number;
  readonly zoom?: number;
}

export interface CanvasSpaceOptions extends CoordinateSpaceOptions {
  readonly displaySpace: DisplaySpace;
  readonly devicePixelRatio: number;
}

export interface ExportSpaceOptions extends CoordinateSpaceOptions {
  readonly imageSpace: ImageSpace;
}

export class CoordinateSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinateSpaceError';
  }
}

function coordinateSpaceId(id: string): CoordinateSpaceId {
  if (!id.trim())
    throw new CoordinateSpaceError('Coordinate space ID is required.');
  return id as CoordinateSpaceId;
}

function validateDimensions(dimensions: ImageDimensions): ImageDimensions {
  if (
    !Number.isFinite(dimensions.width) ||
    dimensions.width <= 0 ||
    !Number.isFinite(dimensions.height) ||
    dimensions.height <= 0
  ) {
    throw new CoordinateSpaceError(
      'Coordinate space dimensions must be positive finite values.',
    );
  }
  return Object.freeze({ width: dimensions.width, height: dimensions.height });
}

function point<S extends CoordinateSpaceRef>(
  x: number,
  y: number,
  coordinateSpace: S,
): Point<S> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CoordinateSpaceError('Coordinates must be finite values.');
  }
  return Object.freeze({ x, y, coordinateSpace });
}

export function createImageSpace(
  id: string,
  width: number,
  height: number,
): ImageSpace {
  return Object.freeze({
    id: coordinateSpaceId(id),
    kind: 'image',
    dimensions: validateDimensions({ width, height }),
  });
}

export function createDisplaySpace(options: DisplaySpaceOptions): DisplaySpace {
  const dimensions = validateDimensions(options.dimensions);
  const fitScale = options.fitScale ?? 1;
  const zoom = options.zoom ?? 1;
  if (
    !Number.isFinite(fitScale) ||
    fitScale <= 0 ||
    !Number.isFinite(zoom) ||
    zoom <= 0
  ) {
    throw new CoordinateSpaceError(
      'Display fit scale and zoom must be positive finite values.',
    );
  }
  const space = {
    id: coordinateSpaceId(options.id),
    kind: 'display' as const,
    dimensions,
    imageSpaceId: options.imageSpace.id,
    fitScale,
    zoom,
  };
  return Object.freeze({
    ...space,
    origin: Object.freeze({
      x:
        options.origin?.x ??
        (dimensions.width - options.imageSpace.dimensions.width * fitScale) / 2,
      y:
        options.origin?.y ??
        (dimensions.height - options.imageSpace.dimensions.height * fitScale) /
          2,
    }),
    pan: Object.freeze({ x: options.pan?.x ?? 0, y: options.pan?.y ?? 0 }),
  });
}

export function createCanvasSpace(options: CanvasSpaceOptions): CanvasSpace {
  if (
    !Number.isFinite(options.devicePixelRatio) ||
    options.devicePixelRatio <= 0
  ) {
    throw new CoordinateSpaceError(
      'Device pixel ratio must be a positive finite value.',
    );
  }
  return Object.freeze({
    id: coordinateSpaceId(options.id),
    kind: 'canvas',
    dimensions: validateDimensions(options.dimensions),
    displaySpaceId: options.displaySpace.id,
    devicePixelRatio: options.devicePixelRatio,
  });
}

export function createNormalizedSpace(
  id: string,
  imageSpace: ImageSpace,
): NormalizedSpace {
  return Object.freeze({
    id: coordinateSpaceId(id),
    kind: 'normalized',
    imageSpaceId: imageSpace.id,
  });
}

export function createExportSpace(options: ExportSpaceOptions): ExportSpace {
  return Object.freeze({
    id: coordinateSpaceId(options.id),
    kind: 'export',
    dimensions: validateDimensions(options.dimensions),
    imageSpaceId: options.imageSpace.id,
  });
}

export function createMaskSpace(
  id: string,
  imageSpace: ImageSpace,
  width: number,
  height: number,
): MaskSpace {
  const dimensions = validateDimensions({ width, height });
  return Object.freeze({
    id: coordinateSpaceId(id),
    kind: 'mask',
    dimensions,
    imageSpaceId: imageSpace.id,
    maskToImageScaleX: imageSpace.dimensions.width / width,
    maskToImageScaleY: imageSpace.dimensions.height / height,
  });
}

function requireSpace(pointValue: Point, expected: CoordinateSpaceRef): void {
  if (
    pointValue.coordinateSpace.id !== expected.id ||
    pointValue.coordinateSpace.kind !== expected.kind
  ) {
    throw new CoordinateSpaceError(
      `Expected geometry in ${expected.kind} space ${expected.id}.`,
    );
  }
}

export function imageToDisplay(
  value: Point<ImageSpace>,
  displaySpace: DisplaySpace,
): Point<DisplaySpace> {
  requireSpace(value, { id: displaySpace.imageSpaceId, kind: 'image' });
  const scale = displaySpace.fitScale * displaySpace.zoom;
  return point(
    displaySpace.origin.x + displaySpace.pan.x + (value.x + 0.5) * scale - 0.5,
    displaySpace.origin.y + displaySpace.pan.y + (value.y + 0.5) * scale - 0.5,
    displaySpace,
  );
}

export function displayToImage(
  value: Point<DisplaySpace>,
  displaySpace: DisplaySpace,
  imageSpace: ImageSpace,
): Point<ImageSpace> {
  requireSpace(value, displaySpace);
  if (displaySpace.imageSpaceId !== imageSpace.id)
    throw new CoordinateSpaceError(
      'Display space is bound to a different image space.',
    );
  const scale = displaySpace.fitScale * displaySpace.zoom;
  return point(
    (value.x - displaySpace.origin.x - displaySpace.pan.x + 0.5) / scale - 0.5,
    (value.y - displaySpace.origin.y - displaySpace.pan.y + 0.5) / scale - 0.5,
    imageSpace,
  );
}

export function imageToNormalized(
  value: Point<ImageSpace>,
  normalizedSpace: NormalizedSpace,
  imageSpace: ImageSpace,
): Point<NormalizedSpace> {
  requireSpace(value, imageSpace);
  if (normalizedSpace.imageSpaceId !== imageSpace.id)
    throw new CoordinateSpaceError(
      'Normalized space is bound to a different image space.',
    );
  return point(
    (value.x + 0.5) / imageSpace.dimensions.width,
    (value.y + 0.5) / imageSpace.dimensions.height,
    normalizedSpace,
  );
}

export function normalizedToImage(
  value: Point<NormalizedSpace>,
  normalizedSpace: NormalizedSpace,
  imageSpace: ImageSpace,
): Point<ImageSpace> {
  requireSpace(value, normalizedSpace);
  if (normalizedSpace.imageSpaceId !== imageSpace.id)
    throw new CoordinateSpaceError(
      'Normalized space is bound to a different image space.',
    );
  return point(
    value.x * imageSpace.dimensions.width - 0.5,
    value.y * imageSpace.dimensions.height - 0.5,
    imageSpace,
  );
}

export function imageToExport(
  value: Point<ImageSpace>,
  exportSpace: ExportSpace,
  imageSpace: ImageSpace,
): Point<ExportSpace> {
  requireSpace(value, imageSpace);
  if (exportSpace.imageSpaceId !== imageSpace.id)
    throw new CoordinateSpaceError(
      'Export space is bound to a different image space.',
    );
  return point(
    ((value.x + 0.5) * exportSpace.dimensions.width) /
      imageSpace.dimensions.width -
      0.5,
    ((value.y + 0.5) * exportSpace.dimensions.height) /
      imageSpace.dimensions.height -
      0.5,
    exportSpace,
  );
}

export function exportToImage(
  value: Point<ExportSpace>,
  exportSpace: ExportSpace,
  imageSpace: ImageSpace,
): Point<ImageSpace> {
  requireSpace(value, exportSpace);
  if (exportSpace.imageSpaceId !== imageSpace.id)
    throw new CoordinateSpaceError(
      'Export space is bound to a different image space.',
    );
  return point(
    ((value.x + 0.5) * imageSpace.dimensions.width) /
      exportSpace.dimensions.width -
      0.5,
    ((value.y + 0.5) * imageSpace.dimensions.height) /
      exportSpace.dimensions.height -
      0.5,
    imageSpace,
  );
}

/** Maps CSS-pixel centers to physical canvas backing-store pixel centers. */
export function displayToCanvas(
  value: Point<DisplaySpace>,
  canvasSpace: CanvasSpace,
): Point<CanvasSpace> {
  requireSpace(value, { id: canvasSpace.displaySpaceId, kind: 'display' });
  return point(
    (value.x + 0.5) * canvasSpace.devicePixelRatio - 0.5,
    (value.y + 0.5) * canvasSpace.devicePixelRatio - 0.5,
    canvasSpace,
  );
}

export function canvasToDisplay(
  value: Point<CanvasSpace>,
  canvasSpace: CanvasSpace,
  displaySpace: DisplaySpace,
): Point<DisplaySpace> {
  requireSpace(value, canvasSpace);
  if (canvasSpace.displaySpaceId !== displaySpace.id)
    throw new CoordinateSpaceError(
      'Canvas space is bound to a different display space.',
    );
  return point(
    (value.x + 0.5) / canvasSpace.devicePixelRatio - 0.5,
    (value.y + 0.5) / canvasSpace.devicePixelRatio - 0.5,
    displaySpace,
  );
}

/** Axis-aligned bounds use the same declared space as the geometry they bound. */
export interface Bounds<S extends CoordinateSpaceRef = CoordinateSpaceRef> {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly coordinateSpace: S;
}

export interface Point<S extends CoordinateSpaceRef = CoordinateSpaceRef> {
  readonly x: number;
  readonly y: number;
  readonly coordinateSpace: S;
}

export interface Polygon<S extends CoordinateSpaceRef = CoordinateSpaceRef> {
  readonly points: readonly Point<S>[];
  readonly coordinateSpace: S;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export type SourceImageRole = 'original' | 'cleaned';
export type SourceImageFormat = 'PNG' | 'JPEG' | 'WEBP';

export interface SourceImageMetadata {
  readonly id: string;
  readonly role: SourceImageRole;
  readonly filename: string;
  readonly format: SourceImageFormat;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly dimensions: ImageDimensions;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface AudioTimebase {
  readonly id: AudioTimebaseId;
  readonly unit: 'seconds' | 'samples';
  readonly sampleRateHz?: number;
}

export interface AudioTime {
  readonly value: number;
  readonly timebase: AudioTimebaseId;
  readonly unit: 'seconds' | 'samples';
}

export interface TimeInterval {
  readonly start: AudioTime;
  readonly end: AudioTime;
}

export interface Provenance {
  readonly source: string;
  readonly version: string;
  readonly inputHashes: readonly string[];
}

export type ReviewStatus =
  'pending-review' | 'accepted' | 'edited' | 'rejected';

export interface AnalysisProposal<T> {
  readonly id: ProposalId;
  readonly schemaVersion: number;
  readonly value: T;
  readonly confidence: Confidence;
  readonly provenance: Provenance;
  readonly status: ReviewStatus;
}
