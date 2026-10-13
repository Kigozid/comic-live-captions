# Comic processing fixtures

This suite is a deterministic, synthetic ground-truth corpus. Every case has an
`original.png`, a corresponding `cleaned.png`, and `ground-truth.json` validated
against `ground-truth.schema.json`. Binary PNG masks for every labeled bubble
and text block live under that fixture's `expected/` directory. The paired pages
are generated from vector primitives by `generate-comic-fixtures.ts`; no comic
page scan, sample-page coordinate, or third-party artwork is used.

Fixture cases:

- `simple`: one rounded speech bubble and short dialogue.
- `ellipse`: elliptical speech bubble.
- `irregular`: non-regular bubble with a tail.
- `multiple-bubbles`: separate bubbles and separate dialogue intervals.
- `overlapping`: overlapping bubble contours and partially overlapping timing.
- `cropped`: a bubble crossing the left page boundary.
- `narration`: a rectangular narration box.
- `thought-bubble`: scalloped thought bubble.
- `long-dialogue`: long OCR string in a large bubble.
- `difficult-lettering`: rotated serif display lettering in an irregular bubble.

## Coordinate and mask conventions

Ground truth coordinates are in the full page `ImageSpace`, with top-left
origin, x increasing right, y increasing down, and integer pixel centers.
Polygons are ordered around their contours. A mask is a full-page, single
foreground shape represented as black background and white foreground; masks
are clipped at image edges. Text-region masks describe the labeled dialogue
block envelope, not individual glyph strokes. `original.png` contains the
lettering while `cleaned.png` removes it and keeps page/bubble artwork.

## Numerical acceptance thresholds

Use `score.ts` for common measurements so test suites apply the same rules.

| Measure                                          |                                                Acceptance |
| ------------------------------------------------ | --------------------------------------------------------: |
| Bubble mask intersection-over-union              |                                                    ≥ 0.90 |
| Bubble mask IoU for cropped or overlapping cases |                                                    ≥ 0.82 |
| Text-region mask IoU                             |                                                    ≥ 0.85 |
| Matched contour coordinate RMS error             |                                                    ≤ 3 px |
| Matched contour maximum point error              |                                                    ≤ 6 px |
| Caption span pixels outside its safe mask        |                                                      ≤ 1% |
| Dialogue start/end boundary error                |                                                  ≤ 0.08 s |
| OCR text                                         | exact after Unicode NFKC, trim, and collapsing whitespace |
| Dialogue mapping                                 |        exact expected bubble ID; no tie accepted silently |

Mask IoU is measured over the full image raster, not over bounding boxes.
Coordinate comparisons require corresponding contour samples in the same order
and coordinate space. Caption overflow is measured against safe-mask runs for
each laid-out line span. Timing error is the larger absolute start/end delta.
The relaxed bubble threshold applies only to the listed cropped/overlap cases,
where clipping or contour ambiguity is intentional. These thresholds are
acceptance criteria for this synthetic corpus; they do not imply the same error
rate on uncurated real comic scans.

## Regenerating assets

Run `node --import tsx/esm tests/fixtures/generate-comic-fixtures.ts` from the
repository root. The generator writes paired PNGs, binary masks, and ground
truth JSON for every fixture directory.

## Caption renderer visual references

Approved full-page PNGs are checked in at
`visual-regression/caption-renderer/references/`. Six fixed cases exercise
rounded, elliptical, irregular, overlapping/multiple, long-dialogue, and
display-lettering output. Each test renders with `RenderingEngine`, decodes
both images to RGBA, and requires an exact pixel match: the accepted changed
pixel count and ratio are both zero. The failure report includes mean and
maximum channel difference and the bounding boxes and pixel counts of all
8-connected changed regions. No visual-diff tolerance can be changed to make a
regression pass.

Run `pnpm test:visual` to compare against approved references. After reviewing
an intentional renderer change, explicitly run `pnpm update:visual-snapshots`
to rewrite the PNG baselines. The update command is separate from the normal
test command and reports each file it replaces; review those image diffs before
accepting the change.
