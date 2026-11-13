# CI flake register

A test that failed CI on content that also passed it, with no fix merged yet. Agents use this
list for one thing: when the merge queue removes a pull request for one of these signatures on an
unchanged head, they re-add it once (see `AGENTS.md`). Anything not listed blocks as usual.

Each new signature gets an owner and an investigation the day it first appears. Remove its row in
the pull request that fixes the cause. Rows never excuse a failure in CI itself: every listed test
still runs and blocks on pull requests, in the queue and on main.

| Test                                                                                                                                                 | Signature                                                                                                                      | First seen                                                                                              | Status                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server` `KiroReplayFixtures.integration.test.ts` › runs provider_thread_resume/kiro through OrchestratorV2 using deterministic replay          | `await_thread_idle` ends with run ordinal 2 still `starting` and no pending requests                                           | 2026-11-10, [run 42793629427](https://github.com/ScientFactory/scient-desktop/actions/runs/42793629427) | Investigating; 85 local passes, Linux CI only                                                                                                                   |
| `apps/web` `AuthoringKeybindingsSettings.dom.browser.test.tsx` › imports and restores the one document profile without touching application bindings | the closing `data-side="bottom"` popup is still present                                                                        | 2026-11-10, [run 42734049717](https://github.com/ScientFactory/scient-desktop/actions/runs/42734049717) | Investigating; no local reproduction                                                                                                                            |
| `apps/web` `AcpSessionManagementSection.browser.test.tsx` › preserves a valid selection and clears a removed project's data (sessions: true)         | Antigravity is selected where Second was expected                                                                              | 2026-11-10, [run 42806285233](https://github.com/ScientFactory/scient-desktop/actions/runs/42806285233) | Investigating; no local reproduction                                                                                                                            |
| Windows packaging › installed voice runtime transcribes the reference recording (`scripts/qualify-whisper-runtime.mjs`)                              | `Offline voice transcription timed out.`: the app's 45 s inference deadline passed (two inspected passes took 1.2 s and 7.5 s) | 2026-11-09, [run 42700145282](https://github.com/ScientFactory/scient-desktop/actions/runs/42700145282) | Investigating (voice runtime); the app's own deadline, so users can meet it. A failure now prints request timings, server exit and output; that decides the fix |

Overleaf macOS is advisory, so the queue never removes a pull request for it, but its disk-image
tests (`OverleafStateStore.test.ts` › on mounted disk images) failed in four of about 30 runs after
2026-11-10 ([run 42898569275](https://github.com/ScientFactory/scient-desktop/actions/runs/42898569275)):
`hdiutil detach -force` or `hdiutil create` exited non-zero, with its reason hidden by `-quiet`.
They had passed 48 runs in a row before that job stopped using setup-vp's cache. The cache is back and hdiutil's own message is printed. It recurred on 2026-11-13
([run 43335716357](https://github.com/ScientFactory/scient-desktop/actions/runs/43335716357)):
`hdiutil detach -force` refused with `couldn't eject "disk31" - Resource busy` while the exFAT case
cleaned up, so something still held the volume. Whether that is Spotlight or a handle the code under
test leaves open decides the fix.

Windows packaging's "Installed desktop must survive the smoke interval and drain on shutdown"
(2026-11-09 to 11-11) was the check, not the app: a helper the backend started (Azure CLI's Python,
from source control discovery) inherited the app's output pipes and could hold them past the 8 s
drain after a forced stop. The smoke now captures output to files and requires the app's own
processes to end, and also checks a normal quit.
