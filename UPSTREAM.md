# Upstream maintenance

This is the private ScientFactory-owned T3-derived desktop candidate. Official
T3 supplies the maintained generic host platform; ScientFactory owns candidate
policy, identity, scientific behavior, release decisions, and every deliberate
divergence.

- Owned repository: `ScientFactory/scient-desktop-next`, default branch `main`
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
[`docs/internals/t3-upstream-sync-20260812-849bac894.md`](docs/internals/t3-upstream-sync-20260812-849bac894.md)
and in `upstream-state.json`. The latest refresh merged the exact official
checkpoint `849bac8946c40420174b4187e36fcf17b5ea7cc4` into the refresh
branch, preserving the complete 11-commit T3 range from the previously
integrated tip `2db08457f2f4eaaa713a067b2ea480ca2b583025`. Later observed T3
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

The 2026-08-12 sync through `849bac894` receives Open VSX theme discovery,
composer and sidebar layout refinements, mobile title regeneration and ordered-
list rendering, the right-panel surface launcher, hosted onboarding alignment,
and the repaired CLI browser OAuth handoff. Of 46 upstream paths, 18 overlapped
Scient work and only three conflicted. Scient adopted all product behavior,
kept its cloud gate and product identity at existing seams, and did not inherit
T3's repository contributor-trust decision.

Synara is not a candidate remote. It remains a research donor and the
foundation of the separately supported continuity application. Valuable
Synara behavior must enter through a separately justified Scient-native lane,
never through a broad merge into this repository.

## Post-D4 Scient-owned feature seams

General Chat is a Scient-owned product and compatibility boundary. Its
capability authority, product policy, naming, workspace routing, navigation,
mobile behavior, and relocation controllers live under explicit Scient
modules; inherited files retain only shared thread-engine support and narrow
mounts. Conversation history continues to use the ordinary thread model.

The repository contains literal history from the then-open T3 projectless-
thread PR `pingdotgg/t3code#5822`, but that commit is provenance for adopted
code, not a runtime or update dependency. Scient does not refresh from open PR
heads. Only an official T3 `main` merge enters through the bounded upstream
process, where equivalent generic primitives may replace adopted compatibility
patches without changing Scient's product contract. See
[Scient General Chat](docs/internals/scient-general-chat.md).

The exact #5822 snapshot and import merge are frozen as a historical exception
in `upstream-state.json` with `followUpdates: false`. The dedicated provenance
workflow rejects new non-official merge parents, while
`scient-general-chat-seams.json` keeps raw projectless decisions and inherited
mounts explicit for future upstream reconciliation.

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

Production identity is a conscious cutover divergence: the package uses the
canonical Scient bundle ID and protocol so the legacy updater can replace the
old app, while keeping `scient-next` user data isolated. Future upstream merges
must not restore T3 publication authority or a dependency on
`t3@<Scient version>`.
