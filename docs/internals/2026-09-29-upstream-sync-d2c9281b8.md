# T3 upstream alignment through `d2c9281b81`

Date: 2026-09-29

Bounded, history-preserving alignment of the official `pingdotgg/t3code` `main`
branch into Scient's owned `main`. Review and provenance record only. It does
not authorize a release, publication, cloud, mobile, or updater activation.

## Frozen boundaries and history

- Owned base for the alignment: `63d9edf1b6eba1387826c8aa6ae7dfe8c292a770`
- Previous official integration tip: `de251fc2971a884cb5b1305ba4daf309dc8cccb0`
- Official target: `d2c9281b8112dc3b2991642c4bdb985e4b08b9bb`
- Complete donor range: **14 official first-parent commits** after
  `de251fc2971…`, linear `main`, 0 merges
- Alignment merge: `eb56e78c44cb76fa37c19d0a99b099a93a69eee3`
  - first parent: owned base `63d9edf1b6…`
  - second parent: exact official target `d2c9281b81…`
- Result: 50 files changed, +2702 / −232
- Branch: `codex/t3-sync-d2c9281b8-20260929`
- Nearest reachable official tag: `v0.0.43-nightly.20260929.2416`
- `upstream` remains fetch-only; push URL re-verified `DISABLED`
- `merge-base(origin/main, upstream/main)` was exactly `de251fc2971…`, so
  nothing was dropped and the history advance is linear

Every one of the 14 official commits is literal ancestry of the merge. No donor
commit was squashed, replayed, or omitted.

## Conflict compositions

29 upstream-touched paths overlapped fork-modified paths. 11 materialized into
conflicts; the remaining overlaps auto-merged and were audited separately.

1. **`apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts`, `DesktopPreReadyPlatform.test.ts`**
   — product identity. Upstream's new icon installation and
   `update-desktop-database` MIME-cache refresh are generic host mechanics and
   were adopted; the source files auto-merged correctly because they derive the
   scheme, entry name, and display name from `DesktopEnvironment` and
   `ElectronProtocol` rather than hardcoding them. The tests hardcode identity
   literals, so the resolution keeps upstream's new assertions against Scient's
   values: production scheme `scient`, `scient.desktop`, `Name=Scient`, icon
   `/xdg/icons/scient.desktop.png`.

2. **`apps/web/src/components/chat/ProviderStatusBanner.tsx`** — composition.
   Kept the fork's runtime/connection/lifecycle failure titles. Adopted
   upstream's `if (status.status === "ready") return null` and its
   `isWarning` refinement so a driver marked `broken` renders as an error
   rather than a warning, which is the point of upstream's OpenCode v2 change.
   The incompatible branch returns above the ready check, so ready-yet-incompatible
   providers still produce a key.

3. **`apps/server/src/serverSettings.ts`** — orthogonal secret lifecycles.
   Upstream generalized the fork's `MANAGEMENT_KEY_REDACTED` into
   `SECRET_REDACTED` plus a `redactSecret()` helper; that naming was adopted
   because it now covers three secret kinds. The fork's
   `usageAccountingSources` read/redact/write/remove lifecycle was kept intact
   alongside upstream's new `bitbucket` lifecycle. Git had interleaved the two
   loops through a shared `.pipe(…)` tail; they were separated.

4. **`packages/contracts/src/settings.ts`** — purely additive. The fork's
   `UsageAccountingSourceConfig` and upstream's `BitbucketSettings` both remain.
   `bitbucket` carries `Schema.withDecodingDefault(…)`, matching `observability`
   and `usageAccountingSources`, so settings persisted by earlier builds decode
   unchanged.

5. **`apps/server/src/provider/model-manifest.json`** — timestamp only. Both
   upstream manifest changes auto-merged: Claude Sonnet 5.5 and the OpenCode v2
   `broken` marking are present. Upstream's newer `updatedAt` was taken.

6. **`apps/server/src/provider/providerCompatibility.test.ts`** — kept the
   fork's eight policy tests that upstream's `76fa23df2e` did not know about.
   Upstream removed an 18-line Codex test; the fork had extended that file with
   its own Pi floor, pre-release scoping, and development-build cases, and those
   defend Scient policy.

7. **`packages/shared/src/threadPullRequests.ts`** — kept the fork's stronger
   `projectId === null` guard and adopted upstream's local-path-remote comment
   above it.

8. **`docs/user/remote-access.md`** — kept Scient's framing. Upstream's
   replacement reintroduced ~60 lines of T3 Connect, `t3 connect`/`t3 auth` CLI,
   relay, and `T3 Code` product text into a document that states Scient provides
   no hosted relay and that a section describing removal from a device's
   connection settings only forgets it on that device. Advertising an
   unavailable capability is a boundary failure, so the fork text was kept and
   upstream's one capability-neutral fact was restated in Scient's voice.

9. **`docs/user/source-control.md`** — the Bitbucket credentials UI genuinely
   ships, so the section was rewritten UI-first with the environment variables
   retained as the documented fallback. The `T3CODE_` prefix note is unchanged:
   it is a retained compatibility identifier. Upstream's troubleshooting section
   was adopted; the fork's `### For …` heading style was kept.

10. **`pnpm-lock.yaml`** — kept `node-pty` at `1.1.0`. See the dependency
    section below.

## Semantic issues found after Git's merge

These were not conflicts. They are the auto-merge class the protocol warns
about, and each was found by reading the composed result.

- **Three upstream identity literals survived in non-conflicted regions** of
  the two desktop test files: `com.t3tools.T3Code.desktop.png` in the
  `copyFileSyncMock` assertion, `x-scheme-handler/t3code` in the
  icon-copy-failure test, and `com.t3tools.T3Code.desktop` plus
  `T3 Code (Alpha)` in the persistent-icon test. Git raised no marker because
  those lines were untouched by the fork. Each contradicted the fork's
  `scient.desktop` entry name and would have failed.
- **`pre-release-scoping-compatibility.json` went stale.** The fork's
  "keeps what releases before release scoping resolve from main unchanged"
  guard pins the bundled manifest as it resolved for 0.6.17. Upstream's OpenCode
  v2 change made the bundled `opencode` policy differ. The fixture is referenced
  only by that test — no production code reads it — so it was updated to the new
  bundled policy. A driver-by-driver comparison confirmed `opencode` was the
  only entry that changed; `codex` still resolves through its `<0.6.18` entry
  and matches.
- **Upstream's ready-state suppression was initially over-applied** in
  `ProviderStatusBanner`. Correcting it was required by
  `ProviderStatusBanner.test.ts`, and the reason it is safe is that the
  incompatible branch returns first.

## Claude version gates

`72330e22c0` adds `claude-sonnet-5-5` with `adapter.claudeCode.minVersion`
`2.1.284`. The existing `claudeAgent` compatibility block recommends and
supports `>=2.1.280`, which has no upper bound. Thus Claude Code 2.1.280–2.1.283
remains supported for other models while Sonnet 5.5 is hidden until 2.1.284.
These are separate provider and model gates, not a merge inconsistency; no
driver-policy change is needed for this alignment.

## Dependencies

`node-pty` stays on `^1.1.0`, the decision recorded in the previous alignment.
Neither `b528a70110` nor `b21f3b7191` changes `apps/server/package.json`, so the
range does not bump the version and the fork's pin is untouched.

- `b528a70110` adds a `win32`-gated `waitForWindowsPid` that waits on a private
  `ready_datapipe` event. Verified directly against the installed
  `node-pty@1.1.0`: `windowsPtyAgent` assigns `this._pid = term.pid` inside its
  constructor, so `spawn()` returns with a valid PID, the `hasPid()` fast path
  resolves immediately, and the private socket is never touched. The
  version-independent half of the same commit — the exit-event replay and the
  `Manager.ts` `eventsActivated` handoff — is adopted and is a real race fix.
- `b21f3b7191` registers `patches/node-pty@1.2.0-beta.15.patch` in
  `patchedDependencies`. pnpm 11 rejects an entry naming an uninstalled
  version: `ERR_PNPM_UNUSED_PATCH`. The registration was removed from
  `pnpm-workspace.yaml` and `pnpm-lock.yaml`; the patch file is retained in the
  tree so it is available when the fork adopts 1.2. No package manifest changed
  in this range.

## Protected-boundary results

| Boundary                                     | Result                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workflows, release, publication, signing     | 0 files touched                                                                                                               |
| `scientDesktopIdentity` and product identity | 0 files touched; fork scheme, entry name, and display name preserved in code and tests                                        |
| Cloud, relay, mobile release holds           | 0 files touched; remote-access doc no longer advertises T3 Connect                                                            |
| State roots, migrations                      | 0 migration files touched; no migration number collision; `bitbucket` decodes from absent                                     |
| `SCIENT-FORK` markers                        | 413 at base, 413 after the merge                                                                                              |
| Contributor trust, secrets, supply chain     | 0 workflow or secret changes; Bitbucket tokens use the existing `ServerSecretStore` and are redacted before reaching a client |
| OTLP, telemetry, updater, background service | 0 files touched                                                                                                               |
| Package manifests                            | 0 `package.json` changes; `pnpm-workspace.yaml` change is the removal of an inapplicable patch entry                          |

## Verification

Environment: repository-declared Node v24.19.0 and pnpm 11.10.0, macOS arm64.
`umask 0022` was set for test runs.

| Gate                                                                                        | Result                                              |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pnpm exec vp fmt --check`                                                                  | pass                                                |
| `pnpm exec vp lint --report-unused-disable-directives`                                      | pass — 0 errors, 1056 pre-existing warnings         |
| `pnpm run typecheck`                                                                        | pass — 0 errors                                     |
| `pnpm run test`                                                                             | 27 failures, all in `src/server.test.ts`; see below |
| `pnpm run build`                                                                            | pass                                                |
| `pnpm run test:desktop-smoke`                                                               | pass                                                |
| `pnpm run brand:check`                                                                      | pass                                                |
| `pnpm run knip:check`                                                                       | pass                                                |
| `pnpm run release:smoke`                                                                    | pass                                                |
| `pnpm run analysis:seams:check`                                                             | pass                                                |
| `pnpm run latex:seams:check`                                                                | pass                                                |
| `pnpm run onboarding:seams:check`                                                           | pass                                                |
| `pnpm run skills:seams:check`                                                               | pass                                                |
| `pnpm run upstream:provenance:check`                                                        | pass                                                |
| `pnpm run alignment:seams:check --base 63d9edf1b6 --upstream-ref upstream/main --head HEAD` | pass — onboarding, skills, analysis, latex          |
| `git diff --cached --check`, `git diff --check`                                             | clean                                               |

`src/server.test.ts` fails 27 cloud, relay, and T3 Connect router tests with
HTTP 500s. This was attributed rather than assumed: the same file was run at
the owned base `63d9edf1b6` in a separate worktree with its own install, and the
failing set is **identical** — same 27 test names, 27 failed / 204 passed in
both. The baseline is missing Clerk/cloud fixtures in this environment, not a
regression. No gate was weakened or skipped to hide it.

Not run locally, and why:

- **Windows and Linux runtime behavior.** `windows-tests.yml` is manual-only by
  the fork's own description ("nothing in the suite passes on Windows yet"), and
  the node-pty reasoning above was verified against the installed 1.1.0 source
  rather than a live Windows spawn.
- **Live-provider checks.** No real provider CLI, credential, or network was
  exercised.
- **Visual and interaction acceptance.** Requires the owner against a running
  candidate; not established by the automated gates.

## Publication boundary

This alignment does not authorize a release, publication, cloud, mobile,
updater, or signing activation. The candidate is presented as a draft pull
request. The worktree is retained for review and is not to be cleaned,
per the protocol.
