# Upstream sync through `c7e6d711d3`

Date: 2026-08-17

## Provenance

- Scient parent: `3db5b6512f9848d396f1b9c7b0d4a1534b7fe991`
- Final official T3 tip: `c7e6d711d3f2982e54854258987509e8f69b31cd`
- Previous official cursor: `bab4b6f02b8bdaf15fd32636a97f69ff657cec50`
- Integrated range: `bab4b6f02b..c7e6d711d3`
- Official commits: 6
- Official files changed: 103
- Initial merge commit: `7fe7233891ce481656f63de9de39cf6c6eea866c`
- Late-advancement merge commit: `c875a80de2739c5aac4a8a2906892ace88aaa7d6`
- Worktree:
  `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-t3-sync-cd096b9ad5-20260817`
- Branch: `agent/t3-sync-cd096b9ad5-20260817`

The initial merge has the owned Scient commit as its first parent and
`cd096b9ad5` as its exact official second parent. A final pre-publication fetch
found one new official commit, which entered through a second literal merge
with `c7e6d711d3` as its second parent. No official commit was replayed or
cherry-picked.

## Official range received

1. `fee10def1a` makes native tooltip linting error-level and migrates inherited
   surfaces to the shared styled Tooltip.
2. `ba46f922a2` adds pull-request provider request budgets and rate-limit
   protection.
3. `949feb61e4` adds browser defaults and Integrations settings.
4. `13458e6510` aligns the context meter.
5. `cd096b9ad5` withholds server agent-browser tools unless settings allow
   access.
6. `c7e6d711d3` makes pull-request review verdicts legible in detail, summary,
   and timeline views.

## Conflict composition

| File                                                          | T3 behavior adopted                                               | Scient behavior retained                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/server/src/provider/CodexDeveloperInstructions.ts`      | Browser-tool instructions are conditional on actual availability. | Scient identity and rich-chat presentation instructions remain unconditional. |
| `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts` | Functional instruction builders and browser-disabled coverage.    | Scient branding and rich-presentation assertions.                             |
| `apps/web/src/components/chat/DraftHeroHeadline.tsx`          | Styled Tooltip for a truncated selector label.                    | Projectless Quick Chat, environment routing, and workspace terminology.       |
| `apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx` | Styled tooltips for controls and resize handles.                  | Static scientific artifacts and multi-edge resizing.                          |

## Scient seams

### Direction-aware tooltip portal

`ScientTooltip` is a narrow wrapper around T3's shared Tooltip primitive. It
reads `ContentDirectionScope` and applies the resolved `dir` to the portaled
popup, because DOM direction inheritance stops at a portal boundary. Scient
surfaces migrated away from native `title` attributes without forking the
generic tooltip implementation.

The migrated surfaces include analysis artifacts, LaTeX, PDF, source journal
icons, provider diagnostics, file previews, project folder drops, inline
workspace images, Vega-Lite network disclosure, and floating preview controls.
The Vega-Lite network badge also exposes the disclosure through an accessible
label, independent of hover and portal rendering.

### Agent browser access

Scient receives T3's explicit `enableAgentBrowserAccess` setting and server
tool-withholding path. Legacy or absent settings decode to `false`, preserving
Scient's fail-closed D4 posture. Users can opt in through the inherited
Integrations setting.

### Deterministic gates

The real-engine LaTeX test now validates the immutable published PDF revision
instead of a build directory that is cleaned after publication. The Git
non-interactive-fetch test controls both `GIT_SSH` and the higher-precedence
`GIT_SSH_COMMAND`, so the awaited local fetch uses the test wrapper in either
host environment. The desktop smoke harness gives Electron a graceful shutdown
window and then force-terminates its own child if Electron ignores `SIGTERM`.

## Validation

- `pnpm run fmt:check`
- `pnpm run lint`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run test`
- `pnpm run test:desktop-smoke`
- focused BiDi, message-timeline, Codex instruction, browser-access, contracts,
  rate-limit, Quick Chat, analysis, LaTeX, and Vega-Lite tests
- `pnpm run quick-chat:seams:check`
- `pnpm run analysis:seams:check`
- `pnpm run latex:seams:check`
- `pnpm run brand:check`
- `pnpm run upstream:provenance:check`
- `git diff --check`

The build retains inherited non-blocking bundle-size, direct-eval, dependency
bundle, and sourcemap warnings. Lint retains 13 existing warnings and no errors.
