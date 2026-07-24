# Voice cancel trash icon design QA

## Scope

Replace only the active voice recorder's circular `X` cancel treatment with a small standalone trash icon. Preserve the composer layout, recorder waveform, duration, stop/insert action, send action, click target, labels, and callbacks.

## Visual evidence

- Before: `docs/pr-screenshots/voice-cancel-trash-icon/before.png`
- Browser-rendered implementation: `docs/pr-screenshots/voice-cancel-trash-icon/after.png`

The approved visual and browser-rendered component were compared together twice. The implementation keeps the 26-to-28-pixel cancel hit target while rendering only a 15-pixel `trash-can-simple` glyph, with no circular fill, border, or hover background.

## Functional evidence

- The cancel action retains its recording and transcription-specific accessible labels.
- Clicking cancel still invokes the caller-owned cancel callback.
- Stop-and-insert and send remain independent and unchanged.
- Recording and transcription states retain their existing disabled and loading behavior.

## Verification

- Focused component unit tests: 4/4 passed.
- Focused Chromium browser tests: 4/4 passed on an isolated test port.
- Browser-rendered visual QA at an 804 x 440 CSS-pixel viewport passed.
- Repository formatting, lint, and typecheck passed; lint reports only pre-existing warnings.
- Full repository test suite: 12/12 tasks passed.
- Desktop and bundled web build: 5/5 tasks passed.
- `git diff --check` passed.

final result: passed
