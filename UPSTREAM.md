# Upstream maintenance

This is the public ScientFactory-owned T3-derived desktop application. Official
T3 supplies the maintained generic host platform; ScientFactory owns product
policy, identity, scientific behavior, release decisions, and every deliberate
divergence.

- Owned repository: `ScientFactory/scient-desktop`, default branch `main`
- Official upstream: `pingdotgg/t3code`, default branch `main`
- Writable remote: `origin`
- Fetch-only remote: `upstream`, push URL `DISABLED`
- Update mode: `thin-fork-merge`
- Machine state: [upstream-state.json](upstream-state.json)
- Bootstrap evidence: [Scient Next D4 bootstrap record](docs/internals/scient-next-d4-bootstrap.md)
- Authoritative migration policy: `Scient/docs/planning/t3-foundation-migration-plan.md`

The D4 bootstrap integration base was
`a2ca89aa10f13a2222e08afd98c66285121d5ba2`, selected from freshly fetched
official `main` only after its untouched baseline passed. That historical
revision remains literal ancestry of owned `main`; it is not merely a reviewed
or observed tip.

The current verified T3 ancestry is recorded in
[`docs/internals/2026-08-24-upstream-sync-e6a109b9f7.md`](docs/internals/2026-08-24-upstream-sync-e6a109b9f7.md)
and in `upstream-state.json`. The latest refresh merged the exact official
checkpoint `e6a109b9f74552eb735968986845e500b98c3c73` into the refresh
branch, preserving the exact range after the previously integrated tip
`b1670ac7d9b5b7bb9d7ebd969f27384daee22813`. Later observed T3
tips never move `integrationBase` by themselves; it advances only after the
exact ancestry and verification gate are complete.

## Receiving T3 updates

1. Refresh `origin`, the fetch-only `upstream`, open pull requests, branches,
   and worktrees before mutation.
2. Create a dedicated short-lived branch from the current owned `main`.
3. Merge one explicit official T3 range with its real Git history. Do not
   squash, replay, or manually rewrite ordinary upstream work.
4. Audit every protected divergence in the D4 bootstrap record: identity,
   state roots, protocols, preview partitions, telemetry/provider identity,
   OTLP, cloud/relay, service/updater/signing/publication, and workflow guards.
5. Resolve conflicts consciously and document any changed Scient-owned seam.
   Keep feature work out of the merge.
6. Run the repository-specific focused checks and complete non-visual suite,
   then use a reviewed draft pull request.
7. Advance `integrationBase` only when the exact upstream ancestry is actually
   present in owned history and the resulting owned head has passed its gate.

The first 2026-08-07 refresh was one such bounded update. It required one small
Scient-owned adaptation because the upstream transfer-budget report exposed a
public `T3 Code` heading; the report now uses the `Scient` product label while
retaining T3 compatibility environment-variable names and repository
attribution. The upstream plan-to-chat, thread-pagination, orchestration,
connection, mobile, and CI changes remain ordinary T3 history.

The second 2026-08-07 refresh was conflict-free and required no Scient-owned
code adaptation. It received T3's plan-mode simplification, per-device provider
settings, and mobile connection visibility fix while preserving the candidate
safety envelope and visible Scient identity.

The 2026-08-09 refresh was also conflict-free and required no Scient-owned code
adaptation. It received the desktop preview-focus zoom fix, the mobile model
and thread settings sheet, the local provider-transcript usage page and its
pricing/chart correction, and persisted diff-panel display mode. The usage
surface reads local provider transcripts through the authenticated server
environment and sends only aggregated buckets and source diagnostics; it does
not authorize cloud publication or make scientific state canonical.

The later 2026-08-09 refresh received 20 more official commits. It preserved
both Scient's durable conversation-fork completion and T3's new archive/settle
session cleanup in the only product-code conflict. Scient deliberately did not
inherit two T3 contributor-trust entries, did not expose T3's live-data dev-DB
copy command, and kept the new hosted-web preview deployment disabled. A new
user-facing project-setting description was relabeled from `T3 Code` to
`Scient`; the compatible `t3.json` contract and official ancestry remain
unchanged.

The 2026-08-11 phase-one refresh received the stable `v0.0.33` line plus its
immediate release-preparation commit. It adopted the ordinary settings,
breadcrumb, confirmation, accessibility, theme, mobile, and security changes;
combined SVG sandboxing with Scient's range-capable asset/PDF seam; and kept
General Chat, local voice, and dropped-file bridges intact. Scient intentionally
did not activate T3's automatic mobile store/OTA workflow or its advisory
fingerprint-label workflow. At that checkpoint, the newer pull-request center
and later nightly commits remained a separate bounded phase.

The 2026-08-11 phase-two integration then received the pull-request center and
the rest of official T3 through `f5fce74169a5629f701aeb8c4535cab6f7bd3c92`.
It preserved General Chat file/PDF behavior, project-only PR/worktree guards,
Scient provider and release policy, and the shared General Chat sidebar row.
The merge reached owned `main` as `5fe83b7adddc6294ae733029d6a0ef2739171649`
and passed post-merge CI plus manual macOS UI acceptance.

The follow-up sync through `65b005f1` adds Shift-click creation in the current
project and Copy Thread ID. Of six upstream-touched paths, three overlapped
Scient changes, two merged automatically, and only `Sidebar.tsx` conflicted.
That conflict represented a real product distinction: one project is still a
multi-target choice when General Chat is available. The exception is isolated
in the Scient-owned General Chat module while T3's new helper remains
upstream-shaped.

The subsequent sync through `ac4780f4` receives T3's mobile composer and
interaction stabilization, hourly past-24-hour usage view, guarded App Store
version handling, and typography-reset correction. Seven of 58 upstream paths
overlapped Scient work; four merged automatically, including the General Chat
mobile mount. The three conflicts were existing release/dependency-policy seams:
Scient retained its disabled mobile-publication job and newer FFF search
dependency while adopting the rest of the upstream files. A focused upstream
typography test used the default value as its supposed changed value; Scient
corrected that characterization from 18 to 19 without altering product logic.

The follow-up sync through `2db08457f` receives theme-aware stage tokens and
OKLCH palettes, PR/Usage sidebar Back buttons, durable thread-error dismiss,
dropdown stacking above toasts, Windows drive-root and Azure DevOps SSH path
fixes, and clearer git action icons. Of 32 upstream paths, 12 overlapped
Scient work and five conflicted. Scient kept its minimal stage branding,
typography profile, and sidebar identity mounts while adopting the upstream
theme pipeline and footer navigation behavior.

The 2026-08-13 sync through `5015d7cf` receives 30 official commits, including
the maintained PR center, Open VSX theme discovery, assisted OAuth handoff
repairs, mobile title/list improvements, and composer/sidebar/diff stability.
Five textual conflicts retained Scient provider onboarding, identity, and
copy while adopting T3's layout and behavior. The merge also explicitly adapts
the new command subtitle for projectless General Chat and gives the Scient
Sources surface a launcher shortcut. T3's contributor-trust change remains in
ancestry without changing the Scient trust list.

The next 2026-08-13 sync advanced the literal T3 ancestry through `97db94c9`.
It adopts the bounded pull-request-panel viewport fix and its regression test
without changing any Scient-owned seam. Its record preserved the exact
remaining range that required conscious trust and instruction reconciliation.

The 2026-08-14 sync through `5304f3e9` receives that complete remainder plus
the following mobile and web improvements. It keeps T3's contributor and
process commits in literal ancestry while preserving Scient's trust list and
stricter rebase rule. T3's new mobile task-sheet architecture becomes the base
implementation, with General Chat restored only through its existing
projectless/environment contract. Scient's sidebar row remains shared between
project and projectless threads while adopting the new configurable
auto-settle-on-merge behavior. The approved Scient wordmark and stage artwork
remain authoritative at the identity conflicts.

The follow-up 2026-08-14 sync through `7e01d33f` receives T3's browser-ready
local-server discovery, Browser-panel favicons, quicker policy tooltips,
simpler desktop-update guidance, and smaller Windows asar packaging. Scient
keeps its approved relevant-versus-other server grouping on top of T3's deeper
server probe, preserves General Chat and Sources, and adds the existing PDF
canvas runtime to T3's new native external/unpack authority so packaged PDF
behavior is not lost.

The 2026-08-15 sync through `8c628f14` receives 22 official commits: mobile
composer, update, Live Activity, and active-turn reliability; desktop updater
and Windows server-tree improvements; remote-editor opening; terminal, git,
timestamp, pull-request, titlebar, tooltip, color, and input fixes. Scient
keeps its identity, projectless General Chat environment routing, provider and
PDF runtimes, publication gates, and owned release workflow. T3's AUR package
sources remain as inert ancestry, but Scient does not enable the AUR workflow
or advertise AUR distribution. The merge also supplies the Scient secret-store
composition required by T3's new agent-awareness path and preserves the PDF
canvas native external in the new Windows `server.asar` layout.

The follow-up 2026-08-15 sync through `6ae9662d8e` receives T3's dark-mode
theme-token specificity fix. Selected appearance themes again override the
generated root dark defaults. The merge was conflict-free; Scient typography,
stage artwork, and the rest of the inherited stylesheet remain unchanged. No
Scient-owned package under `apps/web/src/scient` changed.

The 2026-08-16 sync through `bab4b6f02b` receives 98 official commits covering
workspace-wide file drops, Markdown/file-link handling, command-palette and
sidebar refinements, preview and desktop interaction fixes, mobile themes,
provider and SQLite reliability, and resilient SSH startup. Twenty-seven
textual conflicts retained Scient identity/state/release safeguards, Quick Chat
and durable-fork routing, generated-image and static-analysis artifacts, and
disabled mobile publication while preserving the corresponding generic T3
behavior. A follow-up after that merge keeps Scient BiDi independent of T3's
`parseRawHtml` flag, restores Scient-owned contributor destinations, and tests
the Quick Chat projectless workspace sanitizer. The exact merge record
documents each protected boundary.

The 2026-08-17 sync through `c7e6d711d3` receives six official commits
covering the styled-tooltip lint migration, pull-request provider API budgets,
browser-access defaults and Integrations settings, context-meter alignment,
server-side agent-browser tool withholding, and legible pull-request review
verdicts. Four textual conflicts retained Scient's rich-chat instructions,
projectless Quick Chat, static scientific artifact preview, and multi-edge
preview resizing while composing the matching T3 behavior. Scient adopts T3's
tooltip primitive through one direction-aware portal seam and defaults agent
browser access to opt-in. The exact merge record also documents the post-merge
accessibility and deterministic-gate hardening.

The 2026-08-19 sync through `f2d5fc91e3` receives 30 official commits covering
desktop and preview lifecycle reliability, browser-tab audio, timestamped
pull-request settlement, opt-in provider probing, command-palette and mobile
polish, Clerk passkey fixes, coding-agent-assisted triage, and macOS launchd
service support. Eleven textual conflicts retain projectless Quick Chat,
Sources and scientific preview mounts, provider lifecycle controls, Scient
identity, and D4 service and release guards. The dormant service code uses
distinct Scient systemd and launchd identities, while service registration and
onboarding remain disabled. Orchestration V2 is absent from this official
range and remains excluded.

The 2026-08-20 sync through `beab6886f4` receives 19 official commits covering
composer state drawers, compact tool activity, workspace navigation,
pull-request and usage refinements, OpenCode skill discovery, stable Clerk
Electron dependencies, terminal-close confirmation, file refresh, and desktop
updater reliability. Seven textual conflicts retain Scient's projectless Quick
Chat, queue and steer flow, voice and provider-onboarding controls, Sources
actions, scientific preview anchors, BiDi and fork markers, sidebar identity,
and reading profile while using T3's new component structure. The D4 updater
guard remains effective within T3's new updater concurrency model.

The 2026-08-21 sync through `be7d35aaeb` receives 31 official commits covering
thread bootstrap retry, terminal clipboard and shifted-character fixes,
pinned-thread and reorder stability, per-environment sidebar provider icons,
stream-follow correction, preview rerender performance, UTF-8 HTML asset
serving, slash-command skill listing, Cursor provider default enablement,
HTTPS-default GitHub clones, editor deep-link tightening, and a CI
restructure. Five textual conflicts were composed: the CI workflow adopts T3's
parallelized suite, dedicated Rust job, gated macOS native analysis, and the
single `thread-transfer-results` artifact contract (which also repairs the
transfer-report publisher that Scient's shard-suffixed names had silently
broken) while keeping Scient's documentation fast path, brand check, runner
fleet, and release lanes; the server asset layer combines T3's charset header
with Scient's range-capable PDF/media seam; the sidebar keeps Scient's Quick
Chat seams on top of T3's jump-hint suppression and provider-icon resolution;
and the trust list took T3's superset before the owner reset it the same day
to the two deliberate entries described below. The merge also drops upstream's
removed `.plans/` planning docs per its new work-artifact policy; the content
remains recoverable from history.

The 2026-08-22 sync through `dedcd99a9d` receives 20 official commits covering
background thread creation on cmd+enter, follow-up push ordering, spaced
folder link clicks, wide ordered-list markers, external project icons,
client-origin thread analytics, oversized terminal-grapheme and search-query
crash fixes, SSH remote PATH restoration, and tailscale endpoint hardening.
Fifteen textual conflicts were composed: upstream's client-analytics plumbing
lands verbatim while Scient's fork completion gates stay in the dispatch
path; upstream's incoming migration renumbers to `042` because Scient's
shipped `041` is never reused; the composer assigns draft threads upstream's
background submission while server threads keep Scient steering; the markdown
link layer takes upstream's space-tolerant extraction with Scient's
decoded-key lookup and workspace-root resolution preserved; and the command
palette footer renders Scient's project actions through upstream's new footer
primitive. A pre-merge simulation under-predicted the conflict count; the
real merge's fifteen conflicts and all thirty-two auto-merged overlapping
files were audited against both parents with zero Scient seam losses. The
trust list remains the owner-set two-entry list; upstream's range touched no
governance files.

The 2026-08-23 sync through `b1670ac7d9` receives 16 official commits covering
workspace images, chat timeline and work-log recovery, appearance contrast,
Codex and Claude lifecycle fixes, provider-update recovery, remote default
branch discovery, explicit Codex feedback upload, settled pinned threads, and
faster release packaging. Eleven textual conflicts were composed. Scient keeps
its release authority, Quick Chat, fork serialization, browser-export RPC, and
rich relative-workspace image card while adopting T3's generic behavior around
those seams. The single semantic auto-merge conflict in `ChatMarkdown.tsx` was
collapsed to one renderer: T3 owns classification and generic loading, while
Scient's card remains only where its extra workspace actions apply. The exact
record distinguishes verified ancestry from the separately recorded upstream
review cursor.

The earlier 2026-08-12 record through `849bac894` remains preserved as the
partial checkpoint merged by PR #69. It covers the first 11 commits of this
same contiguous range; it is historical evidence, not the current cursor.

Synara is not a candidate remote. It remains a research donor and the
foundation of the separately supported continuity application. Valuable
Synara behavior must enter through a separately justified Scient-native lane,
never through a broad merge into this repository.

## Post-D4 Scient-owned feature seams

Scient retired its projectless Quick Chat experiment. Every newly created
thread now requires a real owning project; the product surfaces, capability,
relocation command, and seam verifier were removed together. A migration
deletes threads that remain projectless at upgrade time and retries their
attachment cleanup after the transactional database step.

The repository contains literal history from the then-open T3 projectless-
thread PR `pingdotgg/t3code#5822`, but that commit is provenance for adopted
code, not a runtime or update dependency. Scient does not refresh from open PR
heads. Only an official T3 `main` merge enters through the bounded upstream
process. Immutable event decoders retain only the nullability required to
replay a historical thread that was moved into a real project before the
retirement; no current command can create or move a projectless thread.

The exact #5822 snapshot and import merge are frozen as a historical exception
in `upstream-state.json` with `followUpdates: false`. The dedicated provenance
workflow rejects new non-official merge parents. Historical sync reports remain
the provenance record; there is no longer a live Quick Chat seam inventory.

Scient's first-run Getting Started flow is isolated under
`apps/web/src/scient/onboarding`. It reuses canonical provider, project, and
permission state and owns only local presentation and optional
preference records. The inherited-host seams are limited to the empty chat
route, one General settings row, and the generated route entry. Preserve those
mounts through upstream reconciliation;
`scient-onboarding-seams.json` is the machine-readable inventory. See
[Scient getting started](docs/internals/scient-onboarding.md).

Local voice dictation is isolated under `packages/scient-voice`,
`apps/web/src/scient/voice`, and `apps/desktop/src/app/DesktopVoice.ts`. The
inherited-host seams are limited to typed IPC/preload registration, one
composer mount plus a positioned footer, and one desktop-packaging call into
`scripts/lib/scient-voice-build.ts`. Future T3 merges should preserve those
narrow mounts rather than moving voice orchestration into inherited T3
components. See [Scient local voice architecture](docs/internals/scient-voice.md).

Scient's comfortable-reading defaults reuse T3's appearance settings and font
application pipeline. Fixed-pixel and shadow-root exceptions are routed through
four tokens in `apps/web/src/scient/typography/profile.css`; do not spread those
overrides across inherited components during upstream conflict resolution. See
[Scient typography profile](docs/internals/scient-typography.md).

LaTeX compilation is isolated under `apps/server/src/scient/latex` and
`apps/web/src/scient/latex`, with `packages/contracts/src/scientLatex.ts` and
`packages/client-runtime/src/state/scientLatexHttp.ts` as the two owned files
outside those roots. The inherited-host seams are limited to file-preview
recognition, the file-panel surface mount, server config and service wiring, and
the contract and client export points. Future T3 merges should preserve those
narrow mounts rather than moving build coordination or toolchain discovery into
inherited T3 components. See [Scient LaTeX build](docs/internals/scient-latex.md).

Browser HTML-to-PDF export keeps rendering under
`apps/desktop/src/scient/documentExport`, publication under
`apps/server/src/scient/documentArtifacts`, and the browser action plus reader
adapters under `apps/web/src/scient`. Inherited-host seams are limited to the
verified preview-tab lease in `PreviewManager`, one browser-chrome action slot,
typed IPC/preload and RPC/authorization registration, source binding after an
inherited file-open succeeds, one global lifecycle-host mount, one generated-PDF
right-panel mount, and contract export points. Printing, readiness, exact-file
observation, update coordination, validation, publication, Save Copy, and
receipt behavior must remain outside inherited T3 components. See
[Scient browser HTML to PDF export](docs/internals/scient-browser-pdf-export.md).

No upstream update authorizes public release, live cloud, mobile publication,
production credentials, or user-data conversion. Those remain separate Scient
gates even when inherited T3 code contains the capability.

## Scient-owned release seam

The stable release graph is separate from inherited T3 publication. Scient
does not enable T3's tag/nightly workflow, npm publication, relay deployment,
hosted-web aliases, or release bot. The owned manual workflow packages the
exact promoted Scient tree, embeds the owned updater repository, and
distributes the exact server runtime as a GitHub release asset.

The owned release seam also verifies a complete cross-platform updater asset
set, manifest sizes and SHA-512 hashes, final native signing evidence, and an
exact source-commit handoff before publication. Signing credentials are scoped
to their operating-system jobs, and release-owned actions are commit-pinned;
these guards must survive future T3 workflow refreshes.

Production identity is a conscious Scient divergence: the package uses the
canonical Scient bundle ID and protocol while retaining the established
`scient-next` user-data location for compatibility. Future upstream merges must
not restore T3 publication authority or a dependency on `t3@<Scient version>`.
