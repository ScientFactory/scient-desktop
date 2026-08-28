# Scient Docs Help qualification queue — 2026-08-28

Status: Draft
Owner: Yaacov
Created: 2026-08-28
Last updated: 2026-08-28
Purpose: Records the one-time factual qualification of every current docs/user page without treating directory membership as publication approval.
Doc type: Migration ledger
Lifecycle: Temporary migration evidence; retire after durable publication metadata replaces it

## Authority and exit condition

This queue is temporary migration evidence. Current Help remains owned by the
individual pages under `docs/user/`; released behavior remains owned by the
implementation and release evidence. A row marked `Corpus verified` is eligible
for a labelled exact-source preview; directory membership alone is not a public
promise.

Retire this queue after the publishing pilot establishes durable page metadata,
an exact-source publication manifest, and a normal review path for the complete
corpus. Do not keep it as a second registry.

The queue reviews the 33 pages present on the documentation-governance
candidate after the index and truth repairs. It is desktop-first. Mobile,
background-service, remote-environment, inherited T3, provider-specific, and
platform-specific claims require their own applicable evidence. Thirty-two
pages passed this review; the unreleased mobile surface remains on hold.

## Qualification vocabulary

- **Corpus verified:** reviewed against the exact candidate's implementation,
  current capability owners, release state, and focused evidence; eligible for
  the labelled exact-source preview manifest.
- **Hold:** exclude from the first public corpus until the named scope or truth
  problem is resolved.

`Released version` is intentionally recorded as `Select in publishing pilot`.
The website must pin an exact released desktop source before any stable page is
called current; candidate previews use an exact labelled PR head.

## Page queue

| Help source                          | Qualification   | Applicable surface                             | Factual verification                                                                                                                                                                           |
| ------------------------------------ | --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/user/getting-started.md`       | Corpus verified | Desktop                                        | Verified the route, skippable journey, optional local preferences, Settings replay, provider reuse, and Add Project handoff.                                                                   |
| `docs/user/projects.md`              | Corpus verified | Desktop; local and remote distinctions         | Verified local entry helpers, bounded initialization, open-without-setup, preservation, recovery, and retry boundaries; source-provider flows remain inherited.                                |
| `docs/user/file-previews.md`         | Corpus verified | Desktop app; environment-owned files           | Reconciled PR #188 behavior and verified environment authority, bounded preview, exact-path refresh, retained last success, direct-file types, and limits.                                     |
| `docs/user/pdf-reader.md`            | Corpus verified | Desktop app                                    | Verified reader routing, persisted state, search/navigation, save-copy, errors, scanned-document limits, and generated-document identity handoff.                                              |
| `docs/user/latex.md`                 | Corpus verified | Desktop app; supported local/remote toolchains | Reconciled PR #188 and verified toolchain selection, managed TinyTeX, build diagnostics/evidence, PDF freshness, SyncTeX navigation, and platform limits.                                      |
| `docs/user/providers.md`             | Corpus verified | Desktop app; server-authoritative environment  | Verified lifecycle dimensions, PR #190 defaults, remote/read-only behavior, provider links, OpenCode boundary, and troubleshooting.                                                            |
| `docs/user/providers-codex.md`       | Corpus verified | Supported Codex targets                        | Verified runtime selection, official authentication handoff, managed/system boundaries, multi-account homes, continuation compatibility, and limitations.                                      |
| `docs/user/providers-claude.md`      | Corpus verified | Supported Claude targets                       | Verified official account paths, managed runtime, revocation recovery, config-directory isolation, skills routes, account presentation, and advanced bounds.                                   |
| `docs/user/providers-antigravity.md` | Corpus verified | Supported Antigravity targets                  | Verified Google-owned auth, managed runtime, dynamic models, native process/session behavior, permissions, cancellation, and unsupported operations.                                           |
| `docs/user/providers-grok.md`        | Corpus verified | Qualified Grok targets                         | Preserved Early Access scope and verified browser/device-code auth, API-key distinction, cancellation, managed runtime replacement, and recovery.                                              |
| `docs/user/providers-droid.md`       | Corpus verified | Qualified Droid targets                        | Verified Factory/Droid naming, account-mode authority, managed/system runtime boundaries, model/effort discovery, autonomy mapping, and ACP limitations.                                       |
| `docs/user/providers-cursor.md`      | Corpus verified | Qualified Cursor targets                       | Verified assisted browser auth, account probe, external/managed runtime behavior, removal/sign-out separation, recovery, and configuration-owned auth limits.                                  |
| `docs/user/voice-dictation.md`       | Corpus verified | Desktop only                                   | Verified default-off provider text correction, local audio, model download and verification, exact local fallback, platform requirements, and model choices.                                   |
| `docs/user/install.md`               | Corpus verified | Official desktop installers by OS              | Replaced inherited distribution claims with current Scient release authority, artifacts, signature state, first launch, provider setup, and state boundaries.                                  |
| `docs/user/updating.md`              | Corpus verified | Desktop/server version pairing                 | Verified the Scient desktop updater, release channels, AppImage boundary, exact Scient server asset pairing, remote skew, transactional service update, and rollback.                          |
| `docs/user/background-service.md`    | Corpus verified | Linux systemd user; macOS launchd user         | Verified exact Scient release-asset installation, internal executable compatibility name, user-service lifecycle, authentication, transactional update, rollback, and Windows exclusion.       |
| `docs/user/mobile-appearance.md`     | Hold            | Unreleased mobile source                       | The page now states the boundary truthfully, but Scient has no public mobile release. Publish only after release/version qualification and mobile-owned navigation exist.                      |
| `docs/user/remote-access.md`         | Corpus verified | Desktop-managed SSH; advanced direct/Tailscale | Verified SSH discovery and known-host policy, exact Scient remote asset, tunnel/auth/pairing, remote authority, direct/Tailscale alternatives, and exclusion of T3-hosted services.            |
| `docs/user/content-direction.md`     | Corpus verified | Desktop/web chat and composer                  | Verified automatic/RTL/LTR scope, stable streaming direction, grouped lists/tables, technical LTR surfaces, arrow handling, persistence, and shell exclusion.                                  |
| `docs/user/composer.md`              | Corpus verified | Desktop/web composer                           | Verified send, bounded durable queue, explicit steer, queue editing/reordering/deletion, attachments, failure retention, shortcuts, and provider adoption boundary.                            |
| `docs/user/conversation-forks.md`    | Corpus verified | Desktop/web conversations                      | Verified exact-boundary behavior, origin immutability, worktree choice, fresh provider bootstrap, attachment/draft handling, durable readiness, and recovery.                                  |
| `docs/user/sources.md`               | Corpus verified | Desktop app; project-owned Sources             | Verified PDF/Zotero intake, external metadata calls, permissions, duplicates, notes/citations, nine bounded agent tools, default access from PR #190, review state, and limitations.           |
| `docs/user/matlab-run-file.md`       | Corpus verified | Qualified local MATLAB environment             | Corrected release state; verified released AnalysisRun execution/history/figures/results, current Apple Silicon/R2026a qualification, and separation from draft ComputeSession work.           |
| `docs/user/math-in-chat.md`          | Corpus verified | Desktop/web chat                               | Verified delimiters, KaTeX rendering and fallback, copy/export behavior, streaming boundary, local assets, and prose/code distinctions.                                                        |
| `docs/user/diagrams-in-chat.md`      | Corpus verified | Desktop/web chat                               | Verified Mermaid rendering, settled-message boundary, strict security and sanitization, resource limits, export/copy, and local recovery states.                                               |
| `docs/user/charts-in-chat.md`        | Corpus verified | Desktop/web chat                               | Verified Vega-Lite/Plotly distinction, interactions, export/copy, source fidelity, network data behavior, WebGL lifecycle, compatibility, fallback, and layout limits.                         |
| `docs/user/images-in-chat.md`        | Corpus verified | Desktop/web chat and workspace files           | Verified authority-safe workspace paths, supported images, actions, missing/stale behavior, path rejection, and remote-image distinction.                                                      |
| `docs/user/source-control.md`        | Corpus verified | Git and forge integrations                     | Verified GitHub/GitLab behavior, authentication, permissions, remote-environment execution, provider limits, and inherited environment-variable compatibility identifier.                      |
| `docs/user/permission-modes.md`      | Corpus verified | Provider/session permissions                   | Verified provider-specific semantics, approval boundaries, persistence, inherited older sessions, environment authority, and unreleased mobile boundary.                                       |
| `docs/user/keybindings.md`           | Corpus verified | Desktop/web; platform exceptions               | Verified current binding table, platform notation, remapping, conflict handling, authoritative opened path, and inherited standalone compatibility path.                                       |
| `docs/user/thread-sidebar.md`        | Corpus verified | Desktop/web; no public mobile client           | Verified grouping, drag sorting, archive/settle behavior, projectless-thread retirement, current desktop/web surface, and exact Scient server update wording.                                  |
| `docs/user/project-settings.md`      | Corpus verified | Desktop/web project settings                   | Verified icon behavior, local project identity, path ownership, persistence, remote limitations, and the inherited `t3.json` compatibility filename.                                           |
| `docs/user/usage.md`                 | Corpus verified | Provider usage view                            | Verified local transcript scans, pre-aggregated wire data, provider coverage, time ranges, source diagnostics, cost provenance, LiteLLM cache/fallback, and separation from billing/telemetry. |

## Qualification outcome

The full desktop-first review is complete. Keep the single Hold page out of
publication until its release and surface evidence exists. The publishing
manifest may now expand from the 12-page pilot to the 32 `Corpus verified`
pages, always sourcing the Help owner rather than copying prose into the
website repository.

The publishing pilot must record the selected released source identity,
candidate-preview identity, page-level exceptions, correction trigger, and
visible failure behavior. This queue does not select those mechanisms.
