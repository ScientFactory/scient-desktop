# Scient Desktop documentation

This is the documentation index for the active Scient Desktop application.
Some internal documents retain inherited T3 terminology where it describes the
host platform or historical ancestry; that terminology is not product identity
or release authority.

## Using Scient Desktop

- [Install and first run](./user/install.md)
- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Forking conversations](./user/conversation-forks.md)
- [Review usage](./user/usage.md)
- [Customize a project icon](./user/project-settings.md)
- [Mobile appearance](./user/mobile-appearance.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Starting a project](./user/projects.md)
- [File previews](./user/file-previews.md)
- [Reading PDFs](./user/pdf-reader.md)
- [Math in chat and Markdown](./user/math-in-chat.md)
- [LaTeX projects](./user/latex.md)
- [Diagrams in chat](./user/diagrams-in-chat.md)
- [Images in chat](./user/images-in-chat.md)
- [Interactive charts in chat](./user/charts-in-chat.md)
- [Run a MATLAB file](./user/matlab-run-file.md)
- [Sources and Zotero import](./user/sources.md)
- [Background service (Linux)](./user/background-service.md)
- [Providers and assisted setup](./user/providers.md)
  - [Codex](./user/providers-codex.md)
  - [Claude](./user/providers-claude.md)
  - [Antigravity](./user/providers-antigravity.md)
  - [Grok](./user/providers-grok.md)
  - [Droid](./user/providers-droid.md)
  - [Cursor](./user/providers-cursor.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on Scient Desktop

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Provider lifecycle architecture](./internals/provider-lifecycle.md)
- [Provider lifecycle capability audit](./internals/provider-lifecycle-capability-audit.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Scient conversation-fork architecture](./internals/scient-fork-divergence.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Scient project initialization](./internals/scient-project-initialization.md)
- [Scient skills core](./internals/scient-skills.md)
- [Scient Sources foundation](./internals/scient-sources.md)
- [Scient Browser PDF export](./internals/scient-browser-pdf-export.md)
- [Historical PDF export and rendering plan](./internals/scient-pdf-export-rendering-plan.md)
- [Scient analysis runtime foundation](./internals/scient-analysis-runtime-foundation.md)
- [Superseded repository copy of the Scientific Artifact Studio roadmap](./internals/scientific-artifact-studio.md)
- [Canonical cross-product Scientific Artifact Studio roadmap](https://github.com/ScientFactory/Scient/blob/main/docs/planning/scientific-artifact-studio.md)
- [Scient universal file opening](./internals/scient-universal-file-opening.md)
- [Scient PDF reader](./internals/scient-pdf-reader.md)
- [Scient LaTeX](./internals/scient-latex.md)
- [Scient rich chat diagrams](./internals/scient-chat-diagrams.md)
- [Scient inline workspace images](./internals/scient-chat-images.md)
- [Scient rich chat visualizations](./internals/scient-chat-visualizations.md)
- [D4 bootstrap record](./internals/scient-next-d4-bootstrap.md)
- [T3 foundation refresh (2026-08-07)](./internals/t3-foundation-refresh-20260807.md)
- [Upstream maintenance](../UPSTREAM.md)
- [CI gates](./internals/ci.md)
- [Engineering work artifacts](./internals/work-artifacts.md)

### Dated forensic records

These reports preserve investigation evidence and evolution history. They are
not substitutes for current implementation, `UPSTREAM.md`, or maintained help
and capability owners.

- [Scient-specific capability catalog](./reports/scient-specific-capabilities.md)
- [Scient PR and evolution ledger](./reports/scient-pr-and-evolution-ledger.md)
- [Scient/T3 divergence, integration, provenance, and retirements](./reports/scient-t3-divergence-integration-and-retirements.md)

### Runbooks

- [Scient local dev app](./operations/local-dev-app.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
