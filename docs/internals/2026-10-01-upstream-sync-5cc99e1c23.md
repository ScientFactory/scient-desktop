# Upstream alignment through 5cc99e1c23

Scient pull request: see the branch `codex/t3-sync-5cc99e1c23-20261001`.

Date: 2026-10-01. Status: alignment qualification receipt, not release authorization.

## Frozen history

- Owned base: `3b3c0b882e98f8df73544d68849f8101d0aecc18` (`main` at `e0efa3fa4346ea6b7c88c93b25b4638cea715fe4`
  plus the merged release-note and schedule work).
- Previous official integration: `35be904f2fc40aa6d7a42778b6895e8274f3097f`.
- Official target: `5cc99e1c23980d7995a13c47f969b47cb68ed1be`.
- Range: 20 first-parent official commits, 81 files, `+4,360 / -459`.
- Tag relationship: `v0.0.45-nightly.20260930.2493-22-g5cc99e1c23`.
- Branch: `codex/t3-sync-5cc99e1c23-20261001`.
- Upstream merge: `b6444f75637c8587f3c14b2b6a3cfb11daf750d0`; the exact official target
  `5cc99e1c23980d7995a13c47f969b47cb68ed1be` is its second parent.
- Upstream push URL: `DISABLED`.

## Advancements and alignment work

| Official commit | Advancement                                                    | User effect                                                                                                                                         | Classification                                                                                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `792c7dd127`    | Codex Ultrafast double bolt (#14479)                           | The selected Ultrafast tier gets a second bolt.                                                                                                     | Upstream-owned mechanics, adopted.                                                                                                                                                                                                                             |
| `0d9468fea9`    | Contribution triage policy (#14480)                            | None for users.                                                                                                                                     | **Deferred.** `CONTRIBUTING.md` is Scient-owned contributor policy; adopting upstream's triage rules would import another repository's review authority.                                                                                                       |
| `d5980a0ff1`    | Triage exemptions (#14485)                                     | None for users.                                                                                                                                     | **Deferred**, with #14480.                                                                                                                                                                                                                                     |
| `bd89c13020`    | Grok CLI below 1.0.13 marked broken (#14486)                   | Older Grok runtimes report as broken instead of looking usable.                                                                                     | Upstream-owned mechanics, adopted through the manifest and registry.                                                                                                                                                                                           |
| `7c67876983`    | Disconnected environments hidden when adding projects (#14490) | The project chooser stops offering machines that are not connected.                                                                                 | Upstream-owned mechanics, adopted on web and mobile.                                                                                                                                                                                                           |
| `6b286ae8a2`    | Threads without a project (#13612)                             | Would let a thread start in its own scratch folder with no owning project.                                                                          | **Gated off.** Reopens a capability Scient deliberately retired (see below).                                                                                                                                                                                   |
| `9da066dbe9`    | Claude `/compact` correlation (#14497)                         | `/compact` no longer ends early and leaves the thread busy.                                                                                         | Upstream-owned mechanics, adopted.                                                                                                                                                                                                                             |
| `1905846e03`    | Dark+/Light+ theme import ids (#14499)                         | Imported editor themes stop colliding with built-in ids.                                                                                            | Upstream-owned mechanics, adopted.                                                                                                                                                                                                                             |
| `0cf482b08b`    | Screen-reader composer suggestions (#10154)                    | Suggestion lists gain accessible names, loading/empty status, and correct active-descendant wiring.                                                 | Adopted. One Sciant-owned test case needed the new required `listId` prop.                                                                                                                                                                                     |
| `67b175a4c9`    | Parallel npm platform publishing (#14028)                      | None for users.                                                                                                                                     | **Not applicable.** Scient publishes no npm platform packages; `scripts/build-npm-platform-packages.ts` and `scripts/smoke-cli-archive.ts` were deleted in an earlier alignment. The orphaned `publishOrder` helper added by this range was removed with them. |
| `6f8e2534f2`    | Parallel CI and balanced server shards (#14025)                | Shorter CI feedback only.                                                                                                                           | **Split.** Weight-balanced server sharding is adopted through `WeightedShardSequencer`, which is independent of the workflow. The job split, the aggregate `Check` gate, and the runner migration are deferred.                                                |
| `8630e1ac7a`    | Windows packaging setup trim (#14037)                          | None for users.                                                                                                                                     | **Not applicable.** Belongs to upstream's `release-desktop.yml`, which Scient removed.                                                                                                                                                                         |
| `c57a04b722`    | Earlier Windows release builds (#14027)                        | None for users.                                                                                                                                     | **Not applicable.** Same removed workflow; it also requires an `actions: read` grant Scient's release does not use.                                                                                                                                            |
| `783ccf0fdd`    | Early Vercel build, alias after publish (#14029)               | None if deferred.                                                                                                                                   | **Deferred.** It moves the project's public `*.vercel.app` hostname before the GitHub Release exists, which is a publication-authority change.                                                                                                                 |
| `7ab800a43c`    | Claude subagent model attribution (#14540)                     | A subagent shows its own model instead of the parent's.                                                                                             | Upstream-owned mechanics, adopted.                                                                                                                                                                                                                             |
| `921cb3c8bc`    | Restart agent session from the command palette (#14542)        | New skills, plugins, and MCP servers load without starting a new thread.                                                                            | Upstream-owned mechanics, adopted and documented in `docs/user/composer.md`.                                                                                                                                                                                   |
| `71a90ae70e`    | Hotkey recorder accepts plain keys and Tab (#14548)            | Shortcuts using ordinary keys and Tab can be recorded.                                                                                              | Upstream-owned mechanics, adopted.                                                                                                                                                                                                                             |
| `41a8239849`    | Windows CLI smoke temp cleanup (#14553)                        | None for users.                                                                                                                                     | **Not applicable.** `scripts/smoke-cli-archive.ts` does not exist in Scient.                                                                                                                                                                                   |
| `148e6deea0`    | Create a project from just a name (#14527)                     | Would type a name and get a initialized project folder.                                                                                             | **Gated off.** Duplicates Scient's existing "Create & Add" path and bypasses Scient project initialization.                                                                                                                                                    |
| `5cc99e1c23`    | Agent-driven browser downloads (#14573)                        | A download triggered by the agent lands in the browser artifacts folder instead of opening a native Save dialog. Human clicks still get the dialog. | Adopted. Sciant's preview partition naming was preserved in the test double.                                                                                                                                                                                   |

## Two capabilities held behind a Sciant gate

`6b286ae8a2` (#13612) and `148e6deea0` (#14527) are integrated in ancestry but switched
off in the product. Both are behind `SCIENT_DESKTOP_IDENTITY` in
`packages/shared/src/scientDesktopIdentity.ts`:

- `projectlessThreadsEnabled: false`
- `createProjectFromNameEnabled: false`

The server omits `ServerConfig.scratchWorkspaceRoot` and `ServerConfig.newProjectsRoot`
unless its flag is set, and refuses the matching RPC with a "not available" error. Every
client already gates its entry points on those two config fields, so one server-side
switch keeps the palette, the draft menu, the empty state, the keybinding, and mobile
honest: nothing is offered and nothing is created.

**Why threads without a project is off.** `UPSTREAM.md` records that Scient retired the
projectless Quick Chat experiment and that "every newly created thread now requires a real
owning project". `docs/reports/scient-t3-divergence-integration-and-retirements.md` records
the retirement with the reason that projectless conversations weakened source and file
authority and made durable lineage less honest. `upstream-state.json` still carries the
frozen `t3-pr-5822-projectless-threads` snapshot as provenance for that retired
experiment, with `followUpdates: false`. Upstream's gate is only "the data directory is not
inside a Git checkout", which is true for a normal install, so it would have shipped the
capability silently.

**Why create-from-name is off.** Scient already creates a project from any typed path:
the palette's "Create & Add" dispatches `project.create` with
`createWorkspaceRootIfMissing: true`, and that path then runs Scient project
initialization, writing `PROJECT.md`, `AGENTS.md`, and `.scient/project.json`. Upstream's
path instead slugs the name into `<data dir>/projects`, writes its own README and icon,
runs `git init`, and never calls the Sciant initializer, so a user would get two
different "new project" behaviors and Sciant-managed projects from only one of them.

Enabling either flag is a deliberate follow-up with its own product decision, tests, and
release note. The code, contracts, clients, and the folder-creation unit tests
(`apps/server/src/project/NewProject.test.ts`) are all in place for that.

## Conflict composition

Twenty-one paths needed resolution:

- `packages/contracts/src/rpc.ts`, `apps/server/src/auth/RpcAuthorization.ts`,
  `apps/server/src/ws.ts`, `apps/server/vite.config.ts`, and
  `apps/server/src/provider/Layers/ProviderRegistry.ts` were additive on both sides; the
  merge keeps both sets of entries, including Sciant's analysis and compute RPCs and the
  new authorization scopes.
- `apps/web/src/components/CommandPalette.tsx` composed four Sciant-only behaviors with
  upstream's new-project and no-project surfaces: the folder drag-and-drop handlers, the
  `onKeyDownCapture` browse-Enter path, the keyboard-only highlight rule behind the footer
  label, and the bounded browse scope all survive.
  Upstream's replacement browse-Enter block in `handleKeyDown` was **not** taken, because
  `handleBrowseKeyDownCapture` already owns that submission; keeping both would submit the
  same path twice.
- `apps/web/src/components/chat/DraftHeroHeadline.tsx` keeps Sciant's "Choose a workspace"
  copy while adopting upstream's scratch-aware label.
- `apps/desktop/src/preview/Manager.test.ts` keeps the `persist:scient-next-preview-`
  partition naming and adopts upstream's session double, which the new download handling
  needs.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `CONTRIBUTING.md`, and
  `.github/pull_request_template.md` were kept at their Sciant `main` content.
- `docs/user/composer.md` keeps Sciant's product name in the command sentence and gains
  upstream's "Restart agent session" paragraph.
- `docs/user/source-control.md`, `docs/user/thread-sidebar.md`, and
  `docs/user/keybindings.md` were kept at their Sciant `main` content: the sections this
  range adds document capabilities that are gated off, and `docs/user/keybindings.md`
  otherwise linked to a section that does not exist.
- `scripts/build-npm-platform-packages.ts` and `scripts/smoke-cli-archive.ts` remain
  deleted, and `apps/server/scripts/publishOrder.ts` plus its test were removed with them.
- `apps/server/src/project/NewProject.ts` no longer stamps the upstream brand into the
  README it writes into the user's folder.

## Protected-boundary review

Scient branding, the `scient-next` state roots, preview partition prefixes, provider
lifecycle, model selection, the reader-owned scroll policy, the updater and restart flow,
passive preview probing, cloud and relay, analytics consent, service, signing, and the
release and publication workflows were audited. No migration, state root, or release
authority changes. The only server behavior added by this alignment beyond upstream
mechanics is the two capability gates described above.

## Verification

Recorded against merge commit `b6444f75637c8587f3c14b2b6a3cfb11daf750d0` on
`codex/t3-sync-5cc99e1c23-20261001`, macOS arm64, Node 24.19.0, pnpm 11.10.0.

| Check                                                                                     | Result                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm exec vp fmt --check`                                                                | pass                                                                                        |
| `pnpm exec vp lint --report-unused-disable-directives`                                    | pass, 0 errors (warnings are pre-existing)                                                  |
| `pnpm run typecheck`                                                                      | pass                                                                                        |
| `pnpm run test`                                                                           | pass, all packages; server 9,071 passed / 114 skipped, web 9,633 passed, desktop 344 passed |
| `pnpm run build`                                                                          | pass                                                                                        |
| `pnpm run test:desktop-smoke`                                                             | pass                                                                                        |
| `pnpm run brand:check`                                                                    | pass across 2,494 product-surface files                                                     |
| `pnpm run upstream:provenance:check`                                                      | pass at `integrationBase 5cc99e1c23`                                                        |
| `pnpm alignment:seams:check --base 3b3c0b882e --upstream-ref 5cc99e1c23 --snapshot index` | onboarding, skills, analysis, latex, and omp all passed                                     |

One earlier server-suite run timed out on
`includes CORS headers on remote websocket-ticket auth failures` at 120s. That test
passes in isolation and passed again in the full gate, so it is load sensitivity in
that existing test, not a change from this range.

Not established here: visual and interaction acceptance in the desktop app, Windows
and native mobile checks, and hosted CI on the pushed revision.

## Open items for the owner

1. **Threads without a project (#13612).** Enabling it reopens a retired capability.
   Decide whether Scient wants it, and if so what the source and file authority story is
   for a thread with no owning project.
2. **Create a project from a name (#14527).** Decide between upstream's slugged folder
   under the data directory and Scient's existing "Create & Add" path, and whether
   Sciant project initialization must run on a name-created project.
3. **CI restructure (#14025).** Adopting it renames required checks and moves runners to
   a different provider. That needs the `Main merge queue` ruleset updated in the same
   change. The balanced server sharding is already in place and does not depend on it.
4. **Hosted web deployment timing (#14029).** Adopting it moves the public
   `*.vercel.app` hostname before the GitHub Release exists.
5. **Pre-existing and still open:** `main` lacks `.github/workflows/release-desktop.yml`
   while `desktop-macos-preview-publish.yml:287` still calls it, so that workflow fails on
   every run. Restoring upstream's file would also restore the packaging path this
   repository replaced, so it still needs an explicit release decision.
