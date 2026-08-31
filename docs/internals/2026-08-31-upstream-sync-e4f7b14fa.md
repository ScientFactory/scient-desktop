# T3 alignment through e4f7b14fa

Status: qualified alignment receipt. Automated code qualification and the
integrated desktop visual review passed. This record advances the verified
integration boundary; it does not authorize a release or mobile publication.

Role: record the exact donor range, Scient compositions, and verification
boundary for this alignment. The ongoing procedure remains the
[alignment protocol](upstream-alignment-protocol.md), and current machine state
remains [upstream-state.json](../../upstream-state.json).

## Exact boundary

- Owned repository: `ScientFactory/scient-desktop`.
- Owned base: `6e608aadf29ad083c46c8552fea6a1ce4b4e7554`.
- Previous official boundary: `7880a6e583f8a04db2eaeef2366ce9c81c3f7bec`.
- Official donor: `pingdotgg/t3code`.
- Frozen target: `e4f7b14fab0850bff134a3f6bfaf5b71cc8ac9fc`.
- Range: 10 commits; 87 donor-touched paths; 28 paths overlapping Scient work;
  10 textual conflicts.
- No tag points exactly at the target. Its nearest-tag description is
  `v0.0.37-nightly.20260830.1227-14-ge4f7b14fa`.
- Branch: `codex/t3-sync-e4f7b14f-20260831`.
- History-preserving merge: `7a201339f147ce3b818117f6b597f68e04473670`.
  Its first parent is the owned base and its second parent is the frozen target.
- Review: [PR #218](https://github.com/ScientFactory/scient-desktop/pull/218).
- `origin` remains the writable Scient remote; `upstream` remains fetch-only,
  with push URL `DISABLED`.

Local main was clean and fast-forwarded to the exact owned base before creating
the dedicated worktree. Later upstream changes are outside this bounded range.

## Received behavior

| Commit      | Behavior                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `86c9a9288` | Native mobile file selection, incoming sharing, durable outbox ownership, and received-file save/share. |
| `6e324b9bb` | A shorter title-bar scroll fade.                                                                        |
| `12fe2d6d0` | Strip surrounding quotes when repairing Windows PATH entries.                                           |
| `8f525af5a` | Expand inline and remote agent-response images.                                                         |
| `60f2ce027` | Include bounded root repository instructions when generating Git text.                                  |
| `9072aa1fd` | Correct Claude cache pricing and invalidate stale usage-scan caches.                                    |
| `5885a68ad` | Keep expanded image previews above sidebar controls.                                                    |
| `e09b88b6a` | Refresh workspace panels after agent file changes and completed commands.                               |
| `c1e70b5f8` | Render Codex file citations and artifact-template cards on web and mobile.                              |
| `e4f7b14fa` | Add the optional Windows worktree-setup action to `t3.json`.                                            |

## Composition decisions

All ten conflicted paths and the automatically merged overlaps were reviewed.
The conflicts were the mobile thread detail/feed, web chat Markdown/view/logic/
timeline, Files browser/preview panels, and the composer/source-control docs.

### One image renderer, existing file authority

`ChatMarkdown` retains one image renderer. Standalone image cards, authored
dimensions and alignment, titles, SVG fragments, decoded and Windows paths,
root-bound asset resolution, RTL, math, and HTML sanitization remain intact.
The donor's inline-image expansion composes with the existing workspace-image
resource rather than requiring a persisted thread. Images inside links retain
their link action; keyboard expansion applies to independently expandable
images. The sanitizer permits the exact existing Scient image-card metadata
and donor template metadata, not unrestricted HTML.

Codex citation directives enter the existing normalized file-link resolution
path. Template actions append an editable prompt to the current draft and do
not submit it, replace its existing text, install a skill, or grant new file
authority. Scient Skills, queue, and conversation-fork behavior are preserved.

### One open-file freshness owner

Scient already has a native file watcher that handles changes outside an agent
turn, reconnects, unsaved-edit conflicts, and binary preview invalidation.
It remains the primary owner in `useWorkspaceFileRefresh`. The donor's
`useWorkspaceMutationRefresh` is used there only when watching is unavailable;
pending local edits defer that fallback until save/discard settles.

The file tree, working diff, and Git status adopt the donor mutation refresh
directly. The tree still uses Scient's lazy controller, expanded branches,
search scopes, and Open source action. Binary image URLs now include the
existing viewer revision so refreshed bytes cannot be hidden by image caching.
PDF/LaTeX/compute viewers and optimistic editing remain on their existing
freshness and conflict paths. Behavioral tests cover watcher-primary operation,
fallback timing, resource scoping, and binary-view invalidation.

### Native mobile attachments replace the interim fallback

Mobile receives the donor's picker, incoming-share, upload, persistent outbox,
retry, and cleanup mechanics. The obsolete Scient component that opened file
attachments in an external browser is removed; the upstream native component
now owns authenticated asset download and save/share. Unknown future attachment
kinds still show a filename and an explicit unsupported-attachment caption.
Scient's effective Skills selection remains composed into thread creation and
send paths.

There is no new file-extension allowlist or shared-contract change. Desktop/web
generic files remain accepted; retained mobile support is not a new Scient
mobile release. The Expo sharing patch and native configuration require a fresh
native build before qualifying those mobile interactions.

### Other reviewed seams

- Git text generation reads bounded root `AGENTS.md` instructions, with
  `CLAUDE.md` additionally considered only for the Claude driver. Existing
  styles and instance-qualified provider selection remain unchanged.
- Usage pricing retains provider-qualified lookup; an alias is accepted only
  when its pricing is unambiguous. The display is an estimate, not a billing
  assertion.
- Windows PATH normalization is Windows-only. The added setup script is a
  user-imported project action, not an automatic operating-system dispatcher.
  Existing import behavior selects one worktree setup action.
- The earlier documented Claude compaction deferral is preserved. Adjacent
  merge context does not reintroduce its removed context-window plumbing.

## Protected boundaries

Scient product identity, storage roots, browser partitions, rooted assets,
migrations, project ownership, Sources, Skills, voice, analysis, compute, PDF, LaTeX,
rich Markdown, and content direction remain intact. System-installed and
Scient-managed provider lifecycles are unchanged; no passive probe starts login.

No workflow, contributor trust, service, signing, updater, release, hosted web,
mobile publication, analytics/consent, OTLP, cloud, or relay authority is enabled
by this range. Other agents' worktrees and live user data are untouched.

## Verification

Local checks use Node 24.19.0 and pnpm 11.10.0.

- Locked dependency installation, formatting, lint, typecheck (27 workspace
  targets), branding, changed Markdown links, and whitespace checks passed.
  Lint retained existing advisory diagnostics.
- Web: 466 files / 4,313 tests passed.
- Direct mobile suite: 128 files / 958 tests passed.
- Shared client runtime: 59 files / 762 tests passed.
- Focused Git and usage coverage: 5 files / 138 tests passed.
- Focused image, BiDi, math, and freshness composition: 10 files / 173 tests
  passed.
- Analysis, onboarding, Skills, and LaTeX seam checks passed against the exact
  owned base and merge, as did literal upstream provenance verification.
- The full monorepo test run passed with one package at a time and two workers
  per package. Server: 376 files / 4,358 tests (8 files / 40 tests skipped);
  desktop: 70 files / 689 tests (10 skipped). Web and mobile counts match the
  direct suites above. The complete five-target build passed.
- All ten required GitHub checks passed on `7a201339f` and `9f015b49f`: Check, Documentation,
  Verify upstream provenance, Test, all three Test Server shards, Rust, Mobile
  Native Changes, and Release Smoke.
- Desktop startup smoke passed against the built merge with explicit isolated
  state at `<worktree>/.scient-next/startup-smoke` and the safety envelope on.
  The captured test/Electron/helper processes exited, and no process retained
  open files under that smoke state.
- After the owner unlocked the Mac and explicitly authorized final testing and
  merge, integrated Computer Use review passed on `9f015b49f` (the source tree
  of `7a201339f` plus the draft receipt). A synthetic project with three completed
  fixture threads exercised the actual chat renderer without a provider call:
  - inline and centered authored image sizes, the standalone image card, RTL,
    and math rendered correctly;
  - an inline image expanded above the sidebar, Escape closed it, and Enter
    reopened it from the retained keyboard focus;
  - a normalized Codex file citation opened the correct workspace Markdown file;
  - Use template preserved existing draft text, added the template prompt and
    skill reference, did not send, and did not duplicate on a repeated click;
  - an external disk edit automatically refreshed the open file without a
    manual reload. Unsaved-edit and mutation-fallback behavior are covered by
    the automated suites above, not claimed as manual checks.
- Six synthetic visual evidence images were captured outside the repository,
  including before/after expansion, template insertion, and disk refresh. No
  PR-only image assets, real conversations, account details, or credentials were
  committed. The owner reviewed the standalone image-card presentation during
  this pass; a possible floating-toolbar redesign remains a separate follow-up.
- The isolated review app used its own bundle ID, service, state under
  `<worktree>/.scient-next/scient-next-dev`, backend port 15029, and web port 6989. Both listeners, the environment descriptor, web origin, and persistence
  checks passed. The app was stopped through its managed lifecycle; the service,
  runner, Electron, backend, and listeners were verified gone. Computer Use was
  reset and explicitly released to the next reviewer. Other apps were untouched.

Local native static checking could not run SwiftLint, ktlint, or detekt because
their optional executables are absent. GitHub's native-change detector passes
but skips native source lint for this dependency/configuration-only native diff;
that is not a compiled iOS/Android qualification. No native mobile or Windows
runtime result is claimed. Mobile publication stays disabled.

## Publication boundary

The owner explicitly authorized merging PR #218 after testing. The final
documentation/provenance-only commit must pass required hosted checks before
the normal history-preserving merge. This alignment does not publish a release,
activate retained mobile features, or authorize merging any other agent's PR.
