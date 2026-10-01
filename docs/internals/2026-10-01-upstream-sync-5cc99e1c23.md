# Upstream alignment through 5cc99e1c23

Scient pull request: [#428](https://github.com/ScientFactory/scient-desktop/pull/428), opened as a draft and not queued for merge.

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
| `6b286ae8a2`    | Threads without a project (#13612)                             | Starts a conversation in its own plain folder under an internal owning scratch project.                                                             | **Approved and enabled.** Uses Scient's shared picker and workspace admission; does not restore null-project Quick Chat.                                                                                                                                       |
| `9da066dbe9`    | Claude `/compact` correlation (#14497)                         | `/compact` no longer ends early and leaves the thread busy.                                                                                         | Upstream-owned mechanics, adopted.                                                                                                                                                                                                                             |
| `1905846e03`    | Dark+/Light+ theme import ids (#14499)                         | Imported editor themes stop colliding with built-in ids.                                                                                            | Upstream-owned mechanics, adopted.                                                                                                                                                                                                                             |
| `0cf482b08b`    | Screen-reader composer suggestions (#10154)                    | Suggestion lists gain accessible names, loading/empty status, and correct active-descendant wiring.                                                 | Adopted. One Scient-owned test case needed the new required `listId` prop.                                                                                                                                                                                     |
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
| `5cc99e1c23`    | Agent-driven browser downloads (#14573)                        | A download triggered by the agent lands in the browser artifacts folder instead of opening a native Save dialog. Human clicks still get the dialog. | Adopted. Scient's preview partition naming was preserved in the test double.                                                                                                                                                                                   |

## Capability decisions

The owner approved **No project** (#13612) in this alignment. The shared identity
now records:

- `projectlessThreadsEnabled: true`
- `createProjectFromNameEnabled: false`

Scratch conversations are not historical null-project Quick Chat. Each retains a
real owning scratch project and a host-registered plain subfolder in `worktreePath`.
Scient's shared workspace resolver admits that direct canonical child of this
server's scratch root without requiring Git lineage. Both roots must have verified
non-Git evidence; the shared parent, nested descendants, and symlink escapes fail
closed. Existing binding identity, filesystem identity, authority generation, and
scope revision checks still apply across Sources, Documents, and Compute.

**UX composition.** The existing sidebar New thread row opens the existing
"New thread in…" picker, with Add project above No project in a fixed bottom
section while the projects scroll. The current project
stays first and Shift+click keeps its direct-start behavior. The picker still waits
for the project catalog; the No project action cannot bypass that readiness guard.
Scratch uses the same
composer, project selector, provider selection, and Add project flow. The redundant
"or start without a project" prompt under ordinary drafts is removed. Scratch
files remain after thread deletion; moving a started scratch conversation and its
files into a project remains unsupported.

The server advertises `scratchWorkspaceRoot` only outside Git data directories;
VCS detection failures still fail closed. This guard keeps scratch folders from
inheriting a development checkout's Git state. Remote and mobile clients consume
the same advertised capability. Dev candidates now select a persistent scratch root outside the checkout while
keeping their existing profile in place; the selected parent is still checked for Git.

**Why create-from-name remains off.** Scient already creates a project from any
typed path through "Create & Add", dispatching `project.create` with
`createWorkspaceRootIfMissing: true` and then writing `PROJECT.md`, `AGENTS.md`, and
`.scient/project.json` through Scient initialization. Upstream's separate path
slugs a name into `<data dir>/projects`, writes a README and icon, and runs Git init
without the Scient initializer. It remains a separate product decision.

The original qualification below was recorded with both flags off. It is not
qualification of this owner-approved follow-up; see the follow-up record below.

## Conflict composition

Twenty-one paths needed resolution:

- `packages/contracts/src/rpc.ts`, `apps/server/src/auth/RpcAuthorization.ts`,
  `apps/server/src/ws.ts`, `apps/server/vite.config.ts`, and
  `apps/server/src/provider/Layers/ProviderRegistry.ts` were additive on both sides; the
  merge keeps both sets of entries, including Scient's analysis and compute RPCs and the
  new authorization scopes.
- `apps/web/src/components/CommandPalette.tsx` composed four Scient-only behaviors with
  upstream's new-project and no-project surfaces: the folder drag-and-drop handlers, the
  `onKeyDownCapture` browse-Enter path, the keyboard-only highlight rule behind the footer
  label, and the bounded browse scope all survive.
  Upstream's replacement browse-Enter block in `handleKeyDown` was **not** taken, because
  `handleBrowseKeyDownCapture` already owns that submission; keeping both would submit the
  same path twice.
- `apps/web/src/components/chat/DraftHeroHeadline.tsx` keeps Scient's "Choose a workspace"
  copy while adopting upstream's scratch-aware label.
- `apps/desktop/src/preview/Manager.test.ts` keeps the `persist:scient-next-preview-`
  partition naming and adopts upstream's session double, which the new download handling
  needs.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `CONTRIBUTING.md`, and
  `.github/pull_request_template.md` were kept at their Scient `main` content.
- `docs/user/composer.md` keeps Scient's product name in the command sentence and gains
  upstream's "Restart agent session" paragraph.
- `docs/user/source-control.md`, `docs/user/thread-sidebar.md`, and
  `docs/user/keybindings.md` initially stayed at Scient `main` because both capabilities were gated off.
  The owner-approved follow-up adds the scratch picker, shortcut, and plain-folder
  semantics to the existing documentation owners.
- `scripts/build-npm-platform-packages.ts` and `scripts/smoke-cli-archive.ts` remain
  deleted, and `apps/server/scripts/publishOrder.ts` plus its test were removed with them.
- `apps/server/src/project/NewProject.ts` no longer stamps the upstream brand into the
  README it writes into the user's folder.

## Protected-boundary review

Scient branding, the `scient-next` state roots, preview partition prefixes, provider
lifecycle, model selection, the reader-owned scroll policy, the updater and restart flow,
passive preview probing, cloud and relay, analytics consent, service, signing, and the
release and publication workflows were audited. No migration, state root, or release
authority changes. Scient-specific server composition includes the capability policy and the
shared scratch workspace admission described above. The old null-project retirement
migration remains unchanged; scratch conversations retain a real owning project.

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

### Owner-approved scratch follow-up

Recorded on 2026-10-01 against the follow-up working diff based on `c69a5d36ac`,
macOS arm64, Node 24.19.0, pnpm 11.10.0. This evidence supplements the original
gate-off qualification above; it does not reuse that suite as gate-on proof.

- All-workspace `pnpm run typecheck`: pass, including web, server, desktop, and mobile.
- Formatting of the changed files: pass.
- Lint of the changed TypeScript/TSX files: pass, no errors; existing warnings remain.
- `git diff --check`: pass.
- Source review followed creation/ensure, shared picker and draft switching, remote
  capability selection, Sources/Documents admission, Compute root resolution, and
  authority revalidation. Scratch is admitted only at the registered leaf; ordinary
  project/worktree lineage and historical null-project retirement remain intact.

Automated tests, a new build, desktop interaction, live provider turns, and hosted
CI have not been run for this follow-up. The existing gate assertion now describes
Git data-directory withholding, and the resolver fixture supplies its new runtime
configuration dependency. PR #428 remains draft for further qualification/review.
The worktree-local dev profile is subject to the retained Git data-directory guard;
renderer hot reload alone does not refresh the bundled backend.

## Open items for the owner

1. **Create a project from a name (#14527).** Decide between upstream's slugged folder
   under the data directory and Scient's existing "Create & Add" path, and whether
   Scient project initialization must run on a name-created project.
2. **CI restructure (#14025).** Adopting it renames required checks and moves runners to
   a different provider. That needs the `Main merge queue` ruleset updated in the same
   change. The balanced server sharding is already in place and does not depend on it.
3. **Hosted web deployment timing (#14029).** Adopting it moves the public
   `*.vercel.app` hostname before the GitHub Release exists.
4. **Pre-existing and still open:** `main` lacks `.github/workflows/release-desktop.yml`
   while `desktop-macos-preview-publish.yml:287` still calls it, so that workflow fails on
   every run. Restoring upstream's file would also restore the packaging path this
   repository replaced, so it still needs an explicit release decision.

## Dev candidate scratch follow-up, 2026-10-02

Based on `3ade90344d`, the owner requested a runnable candidate for testing. The
runner now derives an external persistent scratch root per resolved candidate state
root. CLI configuration admits it only with a development URL and safety envelope;
the desktop primary forwards it only in development and other backends scrub it.
The existing profile stays in place. Scratch advertisement and workspace admission
use the same selected root, retaining Git detection and canonical-child checks.

Server, scripts, and desktop typechecks passed. Changed-file formatting/lint and
whitespace checks passed. The candidate was stopped through its managed lifecycle;
old runner/app/backend processes and listeners were gone before restarting. The new
candidate responds on backend 15150 and web 7110 with HTTP 200. Native UI inspection
opened the existing New thread picker and confirmed AAA first, No project, and Add
project. The picker was left open for the owner's testing. No provider turn was
submitted; full runtime suites and end-to-end scratch tool execution remain pending.
