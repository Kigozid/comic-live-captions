# Remotion motion-comic export

Job-based MP4 export that places captions inside speech bubbles and keeps the
narration audio as the timing authority. Built on Remotion 4.0.535
(`@comic-captioner/video-composer` + `@remotion/bundler` + `@remotion/renderer`).

## What it produces

- H.264 MP4 (`yuv420p`) with the original narration muxed in (AAC)
- Captions rendered inside the assigned bubble (or a flagged fallback rect)
- Phrase or word-by-word reveal; optional karaoke highlight and word emphasis
- Optional slow pan/zoom and page fade transitions (off by default)
- Letterboxed page geometry — comic art is never cropped to fill the frame
- **Multi-shot panel sequences** — detect panels, pace them across the
  narration (dialogue switch points), and frame each shot with `cameraFocus`
  so the export walks the page instead of holding one static image

## API

| Method   | Path                         | Purpose                                                    |
| -------- | ---------------------------- | ---------------------------------------------------------- |
| `GET`    | `/api/video/export`          | Availability, concurrency settings, license note, job list |
| `POST`   | `/api/video/export`          | Create an explicit export job (validates inputs first)     |
| `GET`    | `/api/video/export/:id`      | Job status + progress                                      |
| `DELETE` | `/api/video/export/:id`      | Cancel a running job                                       |
| `GET`    | `/api/video/export/:id/file` | Download the finished MP4                                  |

Outputs land in `output/video-exports/<jobId>/video.mp4`. Working files are
created under the system temp directory and removed when the job ends or fails.

### Request body (minimum)

```json
{
  "pageImage": "<base64 cleaned page>",
  "pageWidth": 1280,
  "pageHeight": 1920,
  "audio": "<base64 narration>",
  "audioFormat": "wav",
  "durationSeconds": 12.5,
  "fps": 24,
  "resolution": { "resolution": "720p" },
  "captions": [],
  "bubbles": []
}
```

Optional fields: `captionStyle` (font, reveal mode, karaoke, fades),
`camera` (slow zoom/pan), `transitions` (page fade), `backgroundColor`,
`panelSequence` (multi-shot panel walk).

### Multi-page projects (10–15 pages)

Schema v3 stores an explicit `pages[]` list (reading order). The editor’s
**Pages** bar imports multiple comic page images, switches the active workspace
page, and reorders the stack. Audio stays project-global.

Export pacing (`proposePagePacingSlices` in `apps/web/src/project-pages.ts`)
tiles the narration across pages using dialogue coverage; overrides win;
unmapped gaps fill so the sequence always covers the full audio.

```json
{
  "sourcePages": [
    {
      "id": "page-1",
      "image": "<base64>",
      "width": 1280,
      "height": 1920,
      "startSeconds": 0,
      "endSeconds": 6.2,
      "label": "Page 1",
      "bubbles": []
    }
  ],
  "panelSequence": [
    {
      "id": "panel-1",
      "pageId": "page-1",
      "bounds": { "x": 0, "y": 0, "width": 640, "height": 960 },
      "startSeconds": 0,
      "endSeconds": 3
    }
  ]
}
```

`sourcePages` may hold up to 40 pages per job (default target 10–15). Each
entry gets its own image data URL in the Remotion composition. Optional
`panelSequence` steps with `pageId` expand a page into timed panel shots.

### Panel sequence (multi-shot export)

```json
{
  "panelSequence": [
    {
      "id": "panel-1",
      "bounds": { "x": 0, "y": 0, "width": 640, "height": 960 },
      "startSeconds": 0,
      "endSeconds": 4.2,
      "label": "top-left panel"
    },
    {
      "id": "panel-2",
      "bounds": { "x": 640, "y": 0, "width": 640, "height": 960 },
      "startSeconds": 4.2,
      "endSeconds": 9
    }
  ]
}
```

Each step becomes one Remotion page with `cameraFocus` on that panel (the
full cleaned page is still drawn — only the framing changes). Bubbles and
cues are filtered per shot so captions appear on the shot that owns them.

In the editor: **Export sequence → Panel sequence** (default when panels are
detected). Panel timings come from dialogue coverage — a shot holds until the
next panel's first line — then the sequence tiles the full narration. Build
with `buildEditorPanelSequence` (`apps/web/src/panel-sequence.ts`) or
`proposePanelSequenceTimings` / `buildPanelPageSequence`
(`@comic-captioner/video-composer`).

Malformed timestamps, missing assets, unknown bubble ids, and invalid
coordinates are rejected at job creation with `VALIDATION_FAILED` /
`INVALID_INPUT` and a path-qualified message.

## Concurrency (8 GB machines)

| Env                           | Default | Meaning                                          |
| ----------------------------- | ------- | ------------------------------------------------ |
| `COMIC_VIDEO_CONCURRENT_JOBS` | `1`     | Export jobs rendered at once                     |
| `COMIC_VIDEO_CONCURRENCY`     | `1`     | Remotion frame-workers per job                   |
| `COMIC_SKIP_RENDERS`          | unset   | Set `1` to skip the real render integration test |

## Browser prerequisite

Remotion downloads Chrome Headless Shell on first `ensureBrowser()` /
render (~170 MB) into `node_modules/.remotion/chrome-headless-shell/`.
No system Chrome is required.

## Licensing (Remotion)

- **Free License** — individuals, for-profit orgs up to 3 employees,
  non-profits, and evaluation. Allows creating/automating videos including
  commercial use.
- **Company License** — required for for-profit organizations with 4+
  employees, and for hosted automated video-generation products
  ("Remotion for Automators"). See https://www.remotion.dev/docs/license
  and https://www.remotion.dev/docs/license/pricing.
- This repo uses **local rendering only** (no Lambda / paid cloud render).

If you ship Comic Captioner as a multi-tenant video-creation product, budget
for a Company License. Local development and personal use fit the Free tier.

## Tests

```sh
corepack pnpm exec vitest run tests/unit/video-composer.test.ts
corepack pnpm exec vitest run tests/unit/panel-sequence.test.ts
corepack pnpm exec vitest run tests/unit/video-export-job.test.ts
corepack pnpm exec vitest run tests/integration/remotion-render.test.ts
```

The integration tests build a tiny PNG + WAV, run real Remotion renders
(full-page and multi-shot panel sequence), and check the MP4 (ftyp box,
duration, audio stream, codec/pixel format).

## Known limitations

- Word timings are used when present on caption payloads; otherwise tokens
  inside a cue are revealed on a uniform schedule across the cue.
- Multi-page projects cover 10–15 pages via the Pages bar + `sourcePages`.
  Per-page OCR/bubble analysis runs on the _active_ page workspace; switch
  pages to analyze each one. Panel sequences are per-page (optional).
- Caption wrapping without a saved `CaptionLayout` uses deterministic
  character-width metrics (not browser text measurement).
- Preview uses `@remotion/player` at a reduced FPS and is not a substitute for
  the final server render.
- Large multi-page jobs (many high-res images) are bounded by the 80 MB API
  body limit; compress pages or split jobs if needed.
