# Visual reading retention and equation admission — 2026-10-13

This slice retains completed passive reading DOM under a 64 MiB admission estimate,
including idle completions and compatible blocks whose geometry was already cached.
It removes the separate 128-block ceiling. Background admission uses spare capacity;
visited content takes priority. Geometry/formula reuse remains under its separate
24 MiB shared budget. Scrolling does not change cache validity.

Equation activation preserves the original reading wrapper and numbers while the
existing React/MathLive view prepares. Publication waits for painted, stable ink,
keeps the custom element connected, and transfers native input focus. A noneditable
passive focus target and scoped input guards protect pending source. Cancellation
preserves newer source, context, selection, readonly and focus intent. A deadline
retains readable content with local Retry. Initial focus also respects newer user
intent through MathLive's delayed focus callback.

Initializing MathLive under an inert ancestor reproduced a display-input failure:
keyboard events reached the field but native text input never arrived after reveal.
The final staged view uses opacity, pointer exclusion, accessibility exclusion,
explicit focus suppression and input guards; it does not initialize under inert.

## Verification

- Combined Chromium run: **59 passed, 5 failed** across 64 checks. All five failures
  reproduce in the pre-slice control with working font access: display-whitespace
  prose typing; local plain/mixed-font layout; prose typing beside title/statements;
  structural paragraph editing beneath the page fallback overlay. Their existing
  assertions remain unchanged. No new failures remain in this run.
- Focused retention/cache/font/preview units: **15 passed**.
- Web typecheck, scoped formatting, scoped lint and production web build passed.
  Lint retains four existing warnings in viewport/tests and MathField effects.
- Independent fresh browser surface used actual Visual modules and the authorized
  104-page stress source under an in-memory synthetic source owner. Idle work reached
  zero pending units without scrolling. It retained 1,248 passive units at
  67,107,694 estimated bytes (maximum 67,108,864); reusable cache held 9,263,274 bytes.
  No interactive MathLive fields were mounted during reading.
- After an idle pause, a jump to 18,000 px and a jump to the final page both returned
  to the first viewport with identical initial DOM, zero height drift, no page
  preparation mask and no additional whole-document measurement. Page count stayed 104. At final-page demand, retained accounting remained within its limit.
- The stress source remained byte-identical: 362,026 bytes, SHA-256
  `43e050310d024c03c8f01efa14c80473450c4190ddb9985f3bd3a1322283d55e`.
- Two read-only review lanes checked retention/admission and math handoff. Their
  findings were corrected and exercised with held readiness, input protection,
  cancellation, Retry, immediate typing/undo and newer focus-intent tests.

## Qualification boundary

These byte counts are admission estimates, not physical RAM or total JS heap.
Source/model, decoded assets, live input models and transient measurement have
separate costs. There is no claim of identical performance on every device.

The independent runtime surface does not qualify ordinary native project saving,
compilation, native IME or assistive-technology interaction. Existing native
persistence/compiler acceptance limits remain. No user-document writes or manual
candidate lifecycle actions were performed. Reopen the document to create a fresh
Visual editor for manual testing; existing HMR-preserved owners can retain old policy.

Evidence: `/tmp/scient-mounted-retention-20261013/qualification-browser.log`,
`control-browser-fonts.log`, `handoff-final.log`, `unit-final.log`, `types-final.log`,
`fmt-final.log`, `lint.log`, `build.log` and the frozen incremental patch/manifest.
