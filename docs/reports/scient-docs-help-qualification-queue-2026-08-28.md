# Scient Docs Help qualification queue — 2026-08-28

Status: Draft
Owner: Yaacov
Created: 2026-08-28
Last updated: 2026-08-28
Purpose: Reviews every current docs/user page for the first desktop-first Scient Docs pilots without treating directory membership as publication approval.
Doc type: Migration ledger
Lifecycle: Temporary migration evidence; retire after durable publication metadata replaces it

## Authority and exit condition

This queue is temporary migration evidence. Current Help remains owned by the
individual pages under `docs/user/`; released behavior remains owned by the
implementation and release evidence. A row marked `Pilot candidate` or
`Review` is not a public promise.

Retire this queue after the publishing pilot establishes durable page metadata,
an exact-source publication manifest, and a normal review path for the complete
corpus. Do not keep it as a second registry.

The queue reviews the 33 pages present on the documentation-governance
candidate after the Phase 0 index and truth repairs. It is desktop-first.
Mobile, Linux-service, remote-environment, inherited T3, provider-specific, and
platform-specific claims require their own applicable evidence.

## Qualification vocabulary

- **Pilot candidate:** in one of the three accepted vertical pilots; verify and
  correct it before preview publication.
- **Priority review:** outside a pilot but important to the first useful public
  corpus.
- **Review:** potentially publishable after factual, release, surface, and link
  verification.
- **Hold:** exclude from the first public corpus until the named scope or truth
  problem is resolved.

`Released version` is intentionally recorded as `Select in publishing pilot`.
The website must pin an exact released desktop source before any stable page is
called current; candidate previews use an exact labelled PR head.

## Page queue

| Help source                          | Qualification   | Applicable surface                             | Factual verification and required action                                                                                                                                  |
| ------------------------------------ | --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/user/getting-started.md`       | Pilot candidate | Desktop                                        | Pilot 1. Verify the exact released first-run/onboarding route, optional steps, and project handoff.                                                                       |
| `docs/user/projects.md`              | Pilot candidate | Desktop; local and remote distinctions         | Pilot 1. Verify initialization, open-without-setup, Git/worktree behavior, permissions, recovery, and current terminology.                                                |
| `docs/user/file-previews.md`         | Pilot candidate | Desktop app; environment-owned files           | Pilot 2. Reconcile the refreshed current behavior from PR #188, file freshness, direct/open paths, limitations, and remote authority.                                     |
| `docs/user/pdf-reader.md`            | Pilot candidate | Desktop app                                    | Pilot 2. Verify search, outline, save-copy, range behavior, limits, and generated-PDF handoff against the released source.                                                |
| `docs/user/latex.md`                 | Pilot candidate | Desktop app; supported local/remote toolchains | Pilot 2. Reconcile PR #188, managed/system toolchains, diagnostics, build artifacts, SyncTeX, platform limits, and recovery.                                              |
| `docs/user/providers.md`             | Pilot candidate | Desktop app; server-authoritative environment  | Pilot 3 family entry. Verify lifecycle dimensions, defaults from PR #190, remote behavior, provider differences, and troubleshooting links.                               |
| `docs/user/providers-codex.md`       | Pilot candidate | Supported Codex targets                        | Pilot 3. Verify runtime selection, authentication proof, managed/system behavior, account data, and current limitations.                                                  |
| `docs/user/providers-claude.md`      | Pilot candidate | Supported Claude targets                       | Pilot 3. Verify official login paths, managed runtime, revocation recovery, account data, and unsupported targets.                                                        |
| `docs/user/providers-antigravity.md` | Pilot candidate | Supported Antigravity targets                  | Pilot 3. Verify Google/code flow, runtime policy, model/readiness states, cancellation, and unsupported targets.                                                          |
| `docs/user/providers-grok.md`        | Pilot candidate | Qualified Grok targets                         | Pilot 3. Preserve Early Access/qualification boundaries and verify browser/device-code, cancellation, runtime, and model states.                                          |
| `docs/user/providers-droid.md`       | Pilot candidate | Qualified Droid targets                        | Pilot 3. Verify Factory/Droid naming, device pairing, managed runtime, recovery, and current platform evidence.                                                           |
| `docs/user/providers-cursor.md`      | Pilot candidate | Qualified Cursor targets                       | Pilot 3. Verify assisted browser login, external/managed runtime behavior, account display, recovery, and current exclusions.                                             |
| `docs/user/voice-dictation.md`       | Priority review | Desktop only                                   | Privacy correction is in Phase 0. Verify default-off provider text correction, local audio, model download, fallback, platform requirements, and released model set.      |
| `docs/user/install.md`               | Hold            | Desktop installers by OS                       | Title and inherited product wording still say T3 Code. Reconcile current Scient releases, supported OS/architecture, signatures, state migration, and first-run behavior. |
| `docs/user/updating.md`              | Hold            | Desktop/server version pairing                 | Title still says T3 Code. Reconcile Scient update authority, disabled/enabled updater paths, server compatibility, rollback, and release channels.                        |
| `docs/user/background-service.md`    | Hold            | Linux background server only                   | Exclude from desktop-default navigation until Linux support, service installation, security, lifecycle, and applicable releases are explicitly qualified.                 |
| `docs/user/mobile-appearance.md`     | Hold            | Mobile                                         | Outside the desktop-first corpus. Publish only with mobile release/version qualification and mobile-owned navigation.                                                     |
| `docs/user/remote-access.md`         | Priority review | Remote/relay/tunnel clients                    | Verify environment authority, pairing, credentials, permissions, local-versus-server paths, and security limitations.                                                     |
| `docs/user/content-direction.md`     | Priority review | Desktop/web chat and composer                  | Verify auto/RTL/LTR scope, persistence, BiDi limits, excluded shell/technical surfaces, and current release.                                                              |
| `docs/user/composer.md`              | Priority review | Desktop/web composer                           | Verify send/queue/steer behavior, attachments, shortcuts, active-turn states, and provider differences.                                                                   |
| `docs/user/conversation-forks.md`    | Priority review | Desktop/web conversations                      | Verify exact-boundary behavior, origin immutability, workspace choice, provider continuation, failure/recovery, and current terminology.                                  |
| `docs/user/sources.md`               | Priority review | Desktop app; project-owned Sources             | Verify local PDF/Zotero intake, external metadata calls, permissions, duplicate handling, notes/citations, agent access default from PR #190, and limitations.            |
| `docs/user/matlab-run-file.md`       | Priority review | Qualified local MATLAB environment             | Verify current mainline scope, runtime discovery, run/history/figures/results, platform qualification, and distinction from draft ComputeSession work.                    |
| `docs/user/math-in-chat.md`          | Review          | Desktop/web chat                               | Verify supported delimiters, KaTeX behavior, copy/export, error fallback, local assets, and current release.                                                              |
| `docs/user/diagrams-in-chat.md`      | Review          | Desktop/web chat                               | Verify Mermaid subset, security/sandbox behavior, export/copy, fallback, and current release.                                                                             |
| `docs/user/charts-in-chat.md`        | Review          | Desktop/web chat                               | Verify Vega-Lite and Plotly distinctions, local runtime, interactions, export/copy, fallback, and limits.                                                                 |
| `docs/user/images-in-chat.md`        | Review          | Desktop/web chat and workspace files           | Verify authority-safe workspace paths, supported images, actions, missing/stale behavior, and remote distinctions.                                                        |
| `docs/user/source-control.md`        | Review          | Git/forge integrations                         | Verify current GitHub/GitLab/forge support, authentication, permissions, remote environments, and inherited T3 terminology.                                               |
| `docs/user/permission-modes.md`      | Review          | Provider/session permissions                   | Verify provider-specific semantics, approvals, persistence, default behavior, and local/remote authority.                                                                 |
| `docs/user/keybindings.md`           | Review          | Desktop/web; platform exceptions               | Verify every binding against the current app, macOS/Windows/Linux notation, conflicts, and accessibility.                                                                 |
| `docs/user/thread-sidebar.md`        | Review          | Desktop/web/mobile exceptions                  | Verify grouping, sorting, archive/settle behavior, projectless-thread retirement, mobile differences, and current defaults.                                               |
| `docs/user/project-settings.md`      | Review          | Desktop/web project settings                   | Verify icon behavior, project identity, path authority, persistence, and remote limitations.                                                                              |
| `docs/user/usage.md`                 | Review          | Provider usage view                            | Verify local transcript aggregation, pricing/diagnostic boundaries, privacy/data flow, provider coverage, and time-range semantics.                                       |

## Review order

1. Complete the three pilot groups in the order above.
2. Review Voice, Install, Updating, Remote Access, Composer, Sources, and
   conversation forks before calling the first public corpus broadly useful.
3. Keep Hold pages out of stable publication until their exact release and
   surface evidence exists.
4. Review the remaining pages by capability family, updating their current Help
   owners rather than copying prose into a website branch.

The publishing pilot must record the selected released source identity,
candidate-preview identity, page-level exceptions, correction trigger, and
visible failure behavior. This queue does not select those mechanisms.
