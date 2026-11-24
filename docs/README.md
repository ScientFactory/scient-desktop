# Scient Desktop documentation

This is the documentation index for the active Scient Desktop application.
Some internal documents retain inherited T3 terminology where it describes the
host platform or historical ancestry; that terminology is not product identity
or release authority.

Related documentation also lives in the separate
[Scient repository](https://github.com/ScientFactory/Scient/blob/main/docs/README.md).
Topics may span repositories; follow the relevant documents and their ownership
or supersession links rather than assuming either repository contains all guidance.

The logical roles are Help, Capabilities, Architecture, Development,
Operations, Upstream, and Records. They map to the real compatibility paths
below: `docs/user/` is the authored Help source for public Scient Docs;
`docs/internals/` currently contains several maintainer roles;
`docs/operations/` contains runbooks; `UPSTREAM.md` owns T3 divergence and
routes to dated receipts; and package READMEs stay beside the package they
explain. Update the existing owner before creating a new file. The roles do not
require a cosmetic folder migration.

## Using Scient Desktop

- [Install and first run](./user/install.md)
- [Getting started](./user/getting-started.md)
- [Import projects and conversations](./user/welcome-wizard.md)
- [Starting a project](./user/projects.md)
- [Message Scient](./user/composer.md)
- [Providers and assisted setup](./user/providers.md)
  - [Codex](./user/providers-codex.md)
  - [Claude](./user/providers-claude.md)
  - [Antigravity](./user/providers-antigravity.md)
  - [Grok](./user/providers-grok.md)
  - [Droid](./user/providers-droid.md)
  - [Cursor](./user/providers-cursor.md)
  - [OpenCode](./user/providers-opencode.md)
  - [Muse Code](./user/providers-muse.md)
  - [fx](./user/providers-fx.md)
  - [Kiro](./user/providers-kiro.md)
  - [Pi](./user/providers-pi.md)
  - [Oh My Pi](./user/providers-omp.md)
  - [ACP registry](./user/providers-acp.md)
  - [Scient Agent](./user/providers-scient-agent.md)
- [Permission modes](./user/permission-modes.md)
- [Extensions and connected services](./user/extensions.md)
- [Accounts and saved sign-ins](./user/accounts.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Multiple windows](./user/multiple-windows.md)
- [Move a conversation between providers or environments](./user/thread-migration.md)
- [Portable context handoffs](./user/portable-handoffs.md)
- [Activity log](./user/activity-log.md)
- [Tool activity](./user/tool-activity.md)
- [Export a conversation](./user/export-conversations.md)
- [Project settings](./user/project-settings.md)
- [Voice dictation](./user/voice-dictation.md)
- [Projects with several repositories](./user/multi-repo-projects.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Text generation models](./user/text-generation.md)
- [Environment themes](./user/environment-theme.md)
- [Appearance and themes](./user/appearance.md)
- [SnapShots](./user/snap-shot.md)
- [Visual replies](./user/html-renders.md)
- [Import browser sessions](./user/browser-import.md)
- [Default browser](./user/default-browser.md)
- [New browser tab](./user/browser-new-tab.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Secrets](./user/secrets.md)
- [Product usage data](./user/telemetry.md)
- [Send feedback](./user/feedback.md)
- [Remote access](./user/remote-access.md)
- [Invite people to a thread](./user/thread-rooms.md)
- [Scient Connect troubleshooting](./user/scient-connect-troubleshooting.md)
- [Sync and share links](./user/scient-cloud.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [File previews](./user/file-previews.md)
- [Writing Markdown](./user/markdown.md)
- [Reading PDFs](./user/pdf-reader.md)
- [Math in chat and Markdown](./user/math-in-chat.md)
- [LaTeX projects](./user/latex.md)
- [Content direction and RTL/LTR](./user/content-direction.md)
- [Diagrams in chat](./user/diagrams-in-chat.md)
- [Images in chat](./user/images-in-chat.md)
- [Interactive charts in chat](./user/charts-in-chat.md)
- [Scientific computing](./user/scientific-computing.md)
- [Run a MATLAB file](./user/matlab-run-file.md)
- [Library and Zotero import](./user/sources.md)
- [Run a server without the desktop app](./user/background-service.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Workflows](./user/workflows.md)

---

## Working on Scient Desktop

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).
Most code changes do not need an internal documentation update; follow the
[documentation rules](../AGENTS.md#documentation) before adding anything.

### Shared internals (inherited from T3, in reading order)

- [00 · Glossary](./internals/00_glossary.md)
- [01 · Architecture](./internals/01_architecture.md)
- [02 · Effect services](./internals/02_effect-services.md)
- [03 · Providers](./internals/03_providers.md)
- [04 · Environment auth](./internals/04_environment-auth.md)
- [05 · Remote environments](./internals/05_remote.md)
- [06 · T3 Connect](./internals/06_t3-connect.md)
- [07 · Server updates](./internals/07_server-updates.md)
- [08 · Product analytics](./internals/08_product-analytics.md)
- [09 · Connection runtime](./internals/09_connection-runtime.md)
- [10 · Web UI](./internals/10_web-ui.md)
- [11 · Mobile layout](./internals/11_mobile-layout.md)
- [12 · Mobile navigation](./internals/12_mobile-navigation.md)
- [13 · Mobile development lifecycle](./internals/13_mobile-development.md)
- [14 · Translating the UI (i18n)](./internals/14_i18n.md)
- [15 · Testing](./internals/15_testing.md)
- [16 · Performance regression checks](./internals/16_performance-regressions.md)
- [17 · Scripts](./internals/17_scripts.md)
- [Workspace layout](../AGENTS.md#where-code-lives)

### Scient internals

- [Scient providers and drivers](./internals/scient-providers.md)
- [Provider lifecycle architecture](./internals/provider-lifecycle.md)
- [Provider lifecycle capability audit](./internals/provider-lifecycle-capability-audit.md)
- [Codex runtime and authentication](./internals/scient-codex-runtime-auth.md)
- [Custom model connections](./internals/custom-models.md)
- [Scient conversation-fork architecture](./internals/scient-fork-divergence.md)
- [Context handoffs and delivery budgets](./internals/scient-context-handoffs.md)
- [Legacy orchestration import and recovery](./internals/scient-legacy-orchestration-migration.md)
- [Scient native V2 queue and recovery](./internals/scient-thread-queue.md)
- [Scient product analytics](./internals/scient-product-analytics.md)
- [Unread answers and app icon badge](./internals/answer-attention.md)
- [Multiple app windows](./internals/multi-window.md)
- [Thread rooms](./internals/thread-rooms.md)
- [Chat scrolling and motion](./internals/chat-scrolling-and-motion.md)
- [Alignment gates and Scient scripts](./internals/scripts.md)
- [Scient Cloud: copies, share links and take-over](./internals/scient-cloud.md)
- [Inherited T3 Connect troubleshooting](./internals/t3-connect-troubleshooting.md)
- [Scient project initialization](./internals/scient-project-initialization.md)
- [Scient workspace binding](./internals/scient-workspace-binding.md)
- [Scient workspace file browsing and visibility](./internals/scient-workspace-file-visibility.md)
- [Scient onboarding](./internals/scient-onboarding.md)
- [Scient skills core](./internals/scient-skills.md)
- [Scient Extensions: connected services, plugins and Discover](./internals/scient-extensions.md)
- [Scient Accounts](./internals/scient-accounts.md)
- [Scient Sources foundation](./internals/scient-sources.md)
- [Scient conversation export](./internals/scient-conversation-export.md)
  - [Accepted export, conversion, and import proposal](./internals/scient-conversation-export-import-proposal.md)
- [Scient sidebar sections and New thread row](./internals/scient-sidebar-sections.md)
- [Scient voice architecture](./internals/scient-voice.md)
- [Scient Browser PDF export](./internals/scient-browser-pdf-export.md)
- [Scient document PDF export](./internals/scient-document-pdf-export.md)
- [Historical PDF export and rendering plan](./internals/scient-pdf-export-rendering-plan.md)
- [Scient analysis runtime foundation](./internals/scient-analysis-runtime-foundation.md)
- [Scient Compute: sessions, runtimes, agents and notebooks](./internals/scient-compute.md)
- [Scient universal file opening](./internals/scient-universal-file-opening.md)
- [Scient document system and ownership map](./internals/scient-documents.md)
- [Saving workspace files](./internals/scient-file-saving.md)
- [Scient PDF reader](./internals/scient-pdf-reader.md)
- [Scient LaTeX](./internals/scient-latex.md)
  - [Visual authoring](./internals/scient-latex-visual.md)
  - [Visual performance](./internals/scient-latex-visual-performance.md)
- [Scient content direction](./internals/scient-content-direction.md)
- [Scient typography profile](./internals/scient-typography.md)
- [Scient math rendering](./internals/scient-math.md)
- [Scient rich Markdown editor](./internals/scient-rich-markdown-editor.md)
  - [Shared keyboard ownership and authoring settings](./internals/scient-keyboard.md)
- [Scient rich chat diagrams](./internals/scient-chat-diagrams.md)
- [Scient inline workspace images](./internals/scient-chat-images.md)
- [Scient rich chat visualizations](./internals/scient-chat-visualizations.md)
- [Scient release-note system](./internals/scient-release-notes.md)
- [D4 bootstrap record](./internals/scient-next-d4-bootstrap.md)
- [T3 foundation refresh (2026-08-07)](./internals/t3-foundation-refresh-20260807.md)
- [Upstream maintenance and dated integration-record collection](../UPSTREAM.md)
- [T3 upstream alignment protocol](./internals/upstream-alignment-protocol.md)
- [Scient divergence inventory](./internals/scient-divergence-inventory.md)
- [CI gates](./internals/ci.md)
- [Engineering work artifacts](./internals/work-artifacts.md)

### Dated forensic records

These reports preserve investigation evidence and evolution history. They are
not substitutes for current implementation, `UPSTREAM.md`, or maintained help
and capability owners.

- [Scient-specific capability catalog](./reports/scient-specific-capabilities.md)
- [Scient PR and evolution ledger](./reports/scient-pr-and-evolution-ledger.md)
- [Scient/T3 divergence, integration, provenance, and retirements](./reports/scient-t3-divergence-integration-and-retirements.md)
- [Compute backend qualification (2026-09-22)](./reports/scient-compute-backend-qualification-20260922.md)

### Historical delivery and migration records

These records preserve completed plans, review wording, or migration evidence.
Follow their linked successors for current behavior.

- [Provider lifecycle unification delivery proposal](./internals/provider-lifecycle-unification-proposal.md)
- [Conversation-fork modernization PR drafts](./internals/scient-fork-pr-descriptions.md)
- [v0.6.0 migration rehearsal](./operations/v060-migration-rehearsal.md)

### Runbooks

- [Scient local dev app](./operations/local-dev-app.md)
- [Development commands and prerequisites](./operations/00_development.md)
- [Dev container](./operations/01_devcontainer.md)
- [Stable dev-app review](./operations/dev-app-review.md)
- [CI flake register and delivery limits](./operations/ci-flakes.md)
- [Compute backend qualification](./operations/compute-backend-qualification.md)
- [Windows dev app](./operations/local-dev-app-windows.md)
- [Scenarios: real-app proof for a fix](./internals/15_testing.md#scenarios)
- [Scient release](./operations/scient-release.md)
- [Beta releases](./operations/beta-releases.md)
- [Managed provider runtime updates](./operations/managed-provider-runtime-updates.md)
- [Observability](./operations/04_observability.md)
- [Scient Connect operations](./operations/scient-connect.md)
- [Scient Cloud operations](./operations/scient-cloud.md)
- [Mobile release](./operations/mobile-release.md)
- [Inherited mobile source](../apps/mobile/README.md)
- Inherited T3 references: [Connect setup](./operations/02_connect-setup.md),
  [relay observability](./operations/05_relay-observability.md),
  [T3 release](./operations/03_release.md)

## Manuscript integration foundation

- [Overleaf manuscript engine](./internals/scient-overleaf-engine.md) — mounted folder sync, editor saving, conflict review and publication contracts.
