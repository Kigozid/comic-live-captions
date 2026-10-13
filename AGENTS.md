# Comic Captioner Engineering Guide

## Project purpose

Comic Captioner synchronizes dialogue to audio and places captions inside the
matching comic speech bubbles. It is not a conventional subtitle application:
captions must not be rendered in a screen-bottom subtitle track.

## Architecture proposal

Keep the application divided into these layers, with explicit data contracts
between them:

1. **Source assets** — immutable references to the original comic page, cleaned
   page, and audio, plus import metadata. Derived artifacts must not overwrite
   source files.
2. **Image geometry** — deterministic image registration, pixel comparison,
   masks, bubble contours, text regions, and safe regions. Store transforms and
   geometry in page coordinates with documented coordinate conventions.
3. **Semantic analysis** — OCR, comic understanding, ambiguous bubble
   classification, transcription, and dialogue mapping. AI providers return
   structured, schema-validated, confidence-scored proposals; users can review
   and edit them. Providers never mutate application state directly.
4. **Timeline** — audio-derived timing and editable dialogue-to-audio alignment,
   independent of page geometry and rendering.
5. **Caption layout** — deterministic shape-aware fitting, line wrapping, and
   font sizing constrained to the selected bubble's safe region.
6. **Rendering and export** — render approved caption layouts synchronized to
   the timeline and export without introducing a bottom-of-screen subtitle
   track.

The UI or application service layer should orchestrate these layers through
validated commands and explicit state transitions. Persist source references,
geometry, semantic proposals/edits, timeline, and layout as distinct data. Keep
provider-specific code behind replaceable interfaces. Prefer deterministic
algorithms for image alignment, comparison, masks, geometry, fitting, timeline,
and rendering; use AI for semantic interpretation and uncertain recognition.

This is a proposed target architecture, not a claim about the current codebase.
Once repository code is available, map existing modules to these boundaries and
make incremental changes rather than rewriting working code.

## Engineering rules

- Inspect the existing repository, dependencies, architecture, tests, and
  unfinished work before changing application code.
- Preserve working code; avoid unnecessary rewrites and do not add placeholder
  functionality that appears operational but is not.
- Never hard-code comic-specific sample coordinates. Compute geometry from the
  page and keep coordinate systems explicit.
- Use deterministic algorithms for geometry wherever possible. AI may assist
  with OCR, comic understanding, ambiguous bubble classification, dialogue
  semantics, transcription, and dialogue mapping.
- Validate every AI result against a schema, attach a confidence score, and
  provide a manual review/edit path. AI providers must not directly mutate core
  application state.
- Keep source assets, image geometry, semantic analysis, timeline, caption
  layout, and rendering separate.
- Captions belong inside the correct speech bubbles. Never add conventional
  screen-bottom subtitles.
- Add or update tests for meaningful behavior changes and run relevant tests and
  builds after meaningful changes. Report commands/results and any limitations.
- Keep documentation accurate about implemented behavior; do not present
  proposed or unfinished functionality as complete.
