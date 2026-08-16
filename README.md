# Scient desktop

This repository is ScientFactory's T3-derived desktop application. It preserves
the official T3 history while keeping Scient-owned product behavior behind
explicit seams. Release machinery is implemented but does not itself authorize
publication: every release still requires an exact-tree promotion, green source
CI, native packaging and signing proof, and an explicit publishing run.

Production packages use the canonical Scient installation identity so the
legacy updater can install the replacement. The new application keeps its own
`scient-next` data directory; installing it does not silently open or mutate
legacy Scient data. Development builds remain independently named and isolated.

The exact donor base, safety envelope, verification, limitations, and rollback
are recorded in the
[D4 bootstrap record](docs/internals/scient-next-d4-bootstrap.md).
Contributor boundaries are in [AGENTS.md](AGENTS.md), and the continuing T3
relationship is in [UPSTREAM.md](UPSTREAM.md).

Maintainers can run the isolated **Scient (Dev)** application with
`pnpm dev:app`. The canonical installation, lifecycle, feature-worktree, and
recovery procedure is the
[local dev app runbook](docs/operations/local-dev-app.md). This development app
is never a publication source. Its identity, state, and protocol remain
separate from production.

## Scient persistence

Scient owns a versioned SQLite migration runner
(`apps/server/src/orchestration/scient-fork/scientMigrator.ts`). It runs four
ordered, transactional migrations for Scient's active fork lineage and
normalizes legacy provider modes to `transcript-bootstrap`. Its ledger is the
separate `scient_schema_migrations` table; the inherited T3
`effect_sql_migrations` ledger and numbering are never modified.

Existing databases remain compatible: legacy `applied_at` ledger timestamps are
reconciled into `created_at` without losing IDs, names, or timestamps, and
physical compatibility columns remain queryable with their data. Legacy
lineage rows are normalized in place with safe defaults and fail-closed
validation. Migration 4 is an additive compatibility repair for development
databases that already recorded migration 3: it upgrades the quarantine
evidence schema and removes decoder-invalid recovery rows by SQLite row ID,
including rows with null or blank thread IDs. Valid lineage remains active,
and pending, recovery, terminal state, restart, and retry behavior is
preserved. The finalized persistence design and evidence are documented in
[the Scient fork divergence record](docs/internals/scient-fork-divergence.md).

Focused validation for this persistence work:

```bash
pnpm exec vp test run \
  apps/server/src/orchestration/scient-fork/schema.test.ts \
  apps/server/src/orchestration/scient-fork/crossArea.test.ts \
  apps/server/src/orchestration/scient-fork/crossAreaPR15.test.ts
pnpm exec vp fmt --check
pnpm exec vp lint --report-unused-disable-directives
pnpm run typecheck
git diff --check
```

The remainder of this README is inherited T3 product documentation. It remains
useful for understanding the host platform but does not describe the
candidate's current public product or release status.

---

# T3 Code (inherited host documentation)

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login --claudeai`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
