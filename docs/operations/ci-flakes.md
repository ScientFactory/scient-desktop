# CI flake register

A test that failed CI on content that also passed it, with no fix merged yet. Agents use this
list for one thing: when the merge queue removes a pull request for one of these signatures on an
unchanged head, they re-add it once (see `AGENTS.md`). Anything not listed blocks as usual.

Each new signature gets an owner and an investigation the day it first appears. Remove its row in
the pull request that fixes the cause. Rows never excuse a failure in CI itself: every listed test
still runs and blocks on pull requests, in the queue and on main.

| Test                                                                                                                                                 | Signature                                                                            | First seen                                                                                              | Status                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/server` `KiroReplayFixtures.integration.test.ts` › runs provider_thread_resume/kiro through OrchestratorV2 using deterministic replay          | `await_thread_idle` ends with run ordinal 2 still `starting` and no pending requests | 2026-11-10, [run 42793629427](https://github.com/ScientFactory/scient-desktop/actions/runs/42793629427) | Investigating; 85 local passes, Linux CI only                           |
| `apps/server` `OmpEventBudget.native.test.ts` › contains repeated native item overflows without cancelling a reading quiet owner                     | `expected [ Array(1) ] to deeply equal []`                                           | 2026-11-10, [run 42790894928](https://github.com/ScientFactory/scient-desktop/actions/runs/42790894928) | Fix in [#831](https://github.com/ScientFactory/scient-desktop/pull/831) |
| `apps/web` `AuthoringKeybindingsSettings.dom.browser.test.tsx` › imports and restores the one document profile without touching application bindings | the closing `data-side="bottom"` popup is still present                              | 2026-11-10, [run 42734049717](https://github.com/ScientFactory/scient-desktop/actions/runs/42734049717) | Investigating; no local reproduction                                    |
| `apps/web` `AcpSessionManagementSection.browser.test.tsx` › preserves a valid selection and clears a removed project's data (sessions: true)         | Antigravity is selected where Second was expected                                    | 2026-11-10, [run 42806285233](https://github.com/ScientFactory/scient-desktop/actions/runs/42806285233) | Investigating; no local reproduction                                    |

Windows packaging's "Installed desktop must survive the smoke interval and drain on shutdown"
(2026-11-09 to 11-11) was the check, not the app: a helper the backend started (Azure CLI's Python,
from source control discovery) inherited the app's output pipes and could hold them past the 8 s
drain after a forced stop. The smoke now captures output to files and requires the app's own
processes to end, and also checks a normal quit.
