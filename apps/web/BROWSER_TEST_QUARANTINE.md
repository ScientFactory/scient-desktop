# Browser test quarantine

The blocking browser suite runs every test whose full name does not contain
`[geometry:linux]`. Adding that marker is a reviewed quarantine change, not a
broad file exclusion. Runtime, event-stream, teardown, and unhandled-error
tests must never be added here.

Owner: `web/transcript`.

## EventRouter event-stream tests: temporarily non-blocking (not quarantined)

The `Browser test (stable)` CI step is currently `continue-on-error: true`,
matching main's browser-suite policy. Two event-stream tests in
`src/components/EventRouter.browser.tsx` are flaky on hosted Linux:

- `drops duplicate thread events after the thread snapshot sequence advances`
- `flushes only the first assistant chunk immediately for a message`

Their assertions can run before async event delivery/flush settles on slow
runners, so the failing subset varies run to run (2-3 of 8 observed). These are
**not** added to the `[geometry:linux]` table above — event-stream tests are
never marker-quarantined. The fix is to make the assertions wait
(`expect.poll` / `waitFor`) so they are deterministic on slow runners, after
which the stable step returns to blocking (drop the `continue-on-error`).

Owner: `web/transcript`.

Remove an entry after the underlying estimator, font, or layout behavior is
corrected and the untagged test passes in three consecutive blocking Ubuntu CI
runs. These cases were isolated after browser tests first ran on hosted Ubuntu;
their assertions depend directly on pixel, font, or layout measurements.

| Full test name                                                                                                                                                        | Cases | Reason                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | --------------------------------------------------------------------------------- |
| `ChatView timeline estimator parity (full app) [geometry:linux] keeps long user message estimate close at the $name viewport`                                         |     4 | Compares rendered text height with an estimator across viewport widths.           |
| `ChatView timeline estimator parity (full app) [geometry:linux] tracks wrapping parity while resizing an existing ChatView across the viewport matrix`                |     1 | Compares measured and estimated wrapping after viewport resizes.                  |
| `ChatView timeline estimator parity (full app) [geometry:linux] tracks additional rendered wrapping when ChatView width narrows between desktop and mobile viewports` |     1 | Compares pixel-height deltas and their ratio across viewport widths.              |
| `ChatView timeline estimator parity (full app) [geometry:linux] collapses header actions into overflow before they can overlap the thread title`                      |     1 | Compares bounding rectangles under a narrow viewport.                             |
| `ChatView timeline estimator parity (full app) [geometry:linux] keeps the composer visible while a long assistant response forces a viewport relayout`                |     1 | Compares composer, host, and scroll-container geometry across viewport sizes.     |
| `ChatView timeline estimator parity (full app) [geometry:linux] keeps user attachment estimate close at the $name viewport`                                           |     3 | Compares rendered attachment-row height with an estimator across viewport widths. |

Total quarantined cases: **11**.

Explicitly not quarantined:

- delayed attachment loading and optimistic sends remaining bottom-stuck;
- orchestration replay, deduplication, and keybinding notifications;
- browser runtime failures or unhandled errors.
