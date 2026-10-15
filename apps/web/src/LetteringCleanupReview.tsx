import { useRef, useState } from 'react';
import type { CleanPageApiResult } from './clean-page-client.js';

export type MaskEditMode = 'idle' | 'add' | 'exclude';

/**
 * Editor controls for lettering removal: original/cleaned comparison, mask
 * visibility, manual add/exclude brushes, held-region approval, reprocess,
 * and accept/reject. Manual corrections survive reprocessing unless the user
 * explicitly resets them. Unreviewed free-floating text is never erased until
 * approved.
 */
export function LetteringCleanupReview({
  originalUrl,
  cleanedUrl,
  maskUrl,
  result,
  busy,
  accepted,
  showMask,
  maskEditMode,
  pageWidth,
  pageHeight,
  onToggleMask,
  onSetMaskEditMode,
  onPaintMask,
  onApplyMaskEdits,
  onReprocessRegion,
  onApproveRegions,
  onAccept,
  onReject,
  onResetEdits,
}: {
  readonly originalUrl: string | null;
  readonly cleanedUrl: string | null;
  readonly maskUrl: string | null;
  readonly result: CleanPageApiResult | null;
  readonly busy: boolean;
  readonly accepted: boolean;
  readonly showMask: boolean;
  readonly maskEditMode: MaskEditMode;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly onToggleMask: () => void;
  readonly onSetMaskEditMode: (mode: MaskEditMode) => void;
  readonly onPaintMask: (
    mode: 'add' | 'exclude',
    x: number,
    y: number,
    radius: number,
  ) => void;
  readonly onApplyMaskEdits: () => void;
  readonly onReprocessRegion: (regionId: string) => void;
  readonly onApproveRegions: (regionIds: readonly string[]) => void;
  readonly onAccept: () => void;
  readonly onReject: () => void;
  readonly onResetEdits: () => void;
}) {
  const [compareMode, setCompareMode] = useState<'side' | 'original' | 'cleaned'>(
    'side',
  );
  const cleanedRef = useRef<HTMLDivElement>(null);

  const heldRegions = (result?.regions ?? []).filter(
    (region) => region.needsReview && region.method === 'skipped',
  );

  function paintAt(clientX: number, clientY: number) {
    if (maskEditMode === 'idle') return;
    const el = cleanedRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.round(((clientX - rect.left) / rect.width) * pageWidth);
    const y = Math.round(((clientY - rect.top) / rect.height) * pageHeight);
    const radius = Math.max(4, Math.round(Math.min(pageWidth, pageHeight) / 80));
    onPaintMask(maskEditMode, x, y, radius);
  }

  return (
    <section
      id="lettering-cleanup"
      className="comic-secondary-panel mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">
            Lettering removal
          </h2>
          <p className="mt-1 text-sm text-stone-600">
            Bubble-interior lettering is cleaned by default. Unreviewed text
            outside balloons stays until you approve it. The original page is
            never overwritten.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-lg border px-3 py-1.5 text-sm ${showMask ? 'border-rose-500 bg-rose-50 text-rose-800' : 'border-stone-300 bg-white text-stone-700'}`}
            onClick={onToggleMask}
            type="button"
          >
            {showMask ? 'Hide removal mask' : 'Show removal mask'}
          </button>
          <button
            className={`rounded-lg border px-3 py-1.5 text-sm ${maskEditMode === 'add' ? 'border-indigo-500 bg-indigo-50 text-indigo-800' : 'border-stone-300 bg-white text-stone-700'} disabled:opacity-40`}
            disabled={busy}
            onClick={() =>
              onSetMaskEditMode(maskEditMode === 'add' ? 'idle' : 'add')
            }
            type="button"
          >
            Add missed lettering
          </button>
          <button
            className={`rounded-lg border px-3 py-1.5 text-sm ${maskEditMode === 'exclude' ? 'border-emerald-600 bg-emerald-50 text-emerald-800' : 'border-stone-300 bg-white text-stone-700'} disabled:opacity-40`}
            disabled={busy}
            onClick={() =>
              onSetMaskEditMode(maskEditMode === 'exclude' ? 'idle' : 'exclude')
            }
            type="button"
          >
            Restore artwork
          </button>
          <button
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700 disabled:opacity-40"
            disabled={busy}
            onClick={onApplyMaskEdits}
            type="button"
          >
            Apply mask edits
          </button>
          <button
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700"
            onClick={onResetEdits}
            type="button"
          >
            Reset manual edits
          </button>
        </div>
      </div>

      {maskEditMode !== 'idle' && (
        <p className="mb-2 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-900">
          {maskEditMode === 'add'
            ? 'Paint missed lettering (red brush). Then choose Apply mask edits.'
            : 'Paint over-erased artwork (green brush) to exclude it from removal. Then Apply mask edits.'}
        </p>
      )}

      <div className="mb-3 flex gap-2">
        {(
          [
            ['side', 'Side by side'],
            ['original', 'Original'],
            ['cleaned', 'Cleaned'],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            className={`rounded-full px-3 py-1 text-xs font-medium ${compareMode === mode ? 'bg-indigo-700 text-white' : 'bg-stone-100 text-stone-700'}`}
            onClick={() => setCompareMode(mode)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className={`grid gap-3 ${compareMode === 'side' ? 'sm:grid-cols-2' : ''}`}
      >
        {(compareMode === 'side' || compareMode === 'original') &&
          originalUrl && (
            <figure>
              <img
                className="w-full rounded-lg border border-stone-200"
                src={originalUrl}
                alt="Original comic page"
              />
              <figcaption className="mt-1 text-xs text-stone-500">
                Original
              </figcaption>
            </figure>
          )}
        {(compareMode === 'side' || compareMode === 'cleaned') &&
          (cleanedUrl || originalUrl) && (
            <figure
              ref={cleanedRef}
              className={`relative ${maskEditMode !== 'idle' ? 'cursor-crosshair' : ''}`}
              onPointerDown={(event) => {
                if (maskEditMode === 'idle') return;
                event.currentTarget.setPointerCapture(event.pointerId);
                paintAt(event.clientX, event.clientY);
              }}
              onPointerMove={(event) => {
                if (maskEditMode === 'idle' || event.buttons === 0) return;
                paintAt(event.clientX, event.clientY);
              }}
            >
              <img
                className="w-full rounded-lg border border-stone-200 select-none"
                src={cleanedUrl ?? originalUrl!}
                alt="Cleaned comic page"
                draggable={false}
              />
              {showMask && maskUrl && (
                <img
                  aria-label="Removal mask overlay"
                  className="pointer-events-none absolute inset-0 h-full w-full rounded-lg"
                  src={maskUrl}
                  alt=""
                />
              )}
              <figcaption className="mt-1 text-xs text-stone-500">
                Cleaned
                {result
                  ? ` · ${Object.entries(result.methodSummary)
                      .filter(([, count]) => count > 0)
                      .map(([method, count]) => `${count} ${method}`)
                      .join(', ') || 'no regions'}`
                  : ''}
              </figcaption>
            </figure>
          )}
      </div>

      {heldRegions.length > 0 && (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-rose-950">
                Held for review · {heldRegions.length}
              </h3>
              <p className="mt-1 text-[11px] text-rose-900">
                Unreviewed text outside balloons is not auto-erased. Approve
                only regions that are real lettering.
              </p>
            </div>
            <button
              className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              disabled={busy}
              onClick={() =>
                onApproveRegions(heldRegions.map((region) => region.sourceRegionId))
              }
              type="button"
            >
              Approve all held & reprocess
            </button>
          </div>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {heldRegions.map((region) => (
              <li
                key={region.id}
                className="flex items-center justify-between gap-2 rounded border border-rose-200 bg-white px-2 py-1 text-xs"
              >
                <span>
                  <span className="font-medium">{region.sourceRegionId}</span>
                  <span className="text-rose-800">
                    {' '}
                    · {region.needsReview ? 'needs review' : 'ok'}
                  </span>
                </span>
                <button
                  className="rounded border border-stone-300 px-2 py-0.5 text-[11px] disabled:opacity-40"
                  disabled={busy}
                  onClick={() => onApproveRegions([region.sourceRegionId])}
                  type="button"
                >
                  Approve
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <ul className="mt-4 space-y-1">
          {result.warnings.map((warning, index) => (
            <li
              key={`${warning.regionId}:${warning.code}:${index}`}
              className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900"
            >
              <span className="font-medium">{warning.code}</span> ·{' '}
              {warning.regionId}: {warning.message}
            </li>
          ))}
        </ul>
      )}

      {result && result.regions.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead>
              <tr className="border-b border-stone-200 text-stone-500">
                <th className="py-1 pr-3">Region</th>
                <th className="py-1 pr-3">Method</th>
                <th className="py-1 pr-3">Context</th>
                <th className="py-1 pr-3">Pixels</th>
                <th className="py-1 pr-3">Confidence</th>
                <th className="py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.regions.map((region) => (
                <tr
                  key={region.id}
                  className="border-b border-stone-100 text-stone-800"
                >
                  <td className="py-1 pr-3 font-medium">
                    {region.sourceRegionId}
                  </td>
                  <td className="py-1 pr-3">
                    {region.method}
                    {region.needsReview ? ' · review' : ''}
                  </td>
                  <td className="py-1 pr-3">{region.context}</td>
                  <td className="py-1 pr-3">{region.maskPixelCount}</td>
                  <td className="py-1 pr-3">
                    {Math.round(region.methodConfidence * 100)}%
                  </td>
                  <td className="py-1">
                    <button
                      className="rounded border border-stone-300 px-2 py-0.5 text-[11px] disabled:opacity-40"
                      disabled={busy}
                      onClick={() => onReprocessRegion(region.sourceRegionId)}
                      type="button"
                    >
                      Reprocess
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          className={`rounded-lg px-4 py-2 text-sm font-semibold ${accepted ? 'bg-emerald-700 text-white' : 'bg-indigo-700 text-white hover:bg-indigo-800'} disabled:opacity-50`}
          disabled={busy}
          onClick={onAccept}
          type="button"
        >
          {accepted ? 'Clean page accepted' : 'Accept clean page'}
        </button>
        <button
          className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 disabled:opacity-50"
          disabled={busy}
          onClick={onReject}
          type="button"
        >
          Reject
        </button>
      </div>
    </section>
  );
}
