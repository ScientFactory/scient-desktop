# Upstream sync through `dedcd99a9d`

Date: 2026-08-22

## Provenance

- Scient parent: `c17abba0a79ffcbd46933c39a48c48fc248347af`
- Official T3 tip: `dedcd99a9d16240327ce763b885b326aff607bdb`
- Previous official cursor: `be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e`
- Integrated range: `be7d35aaeb..dedcd99a9d`
- Official commits: 20
- Official files changed: 99 (+2523/−323)
- Merge commit: `e5669c1cbcab1c756c09ec97f8c013d03320e65d`
- Worktree:
  `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-t3-sync-dedcd99a9d-20260822`
- Branch: `agent/t3-sync-dedcd99a9d-20260822`

The merge commit has the owned Scient parent first and the exact official T3
tip second. No official commit was replayed, rebased, squashed, or
cherry-picked.

## Official range received

1. `0a46daaf63` keeps messages clear of composer banners.
2. `837f6b871a` renames threads by double-clicking the header title.
3. `292c6dd8c2` removes the model picker's double border.
4. `9b5d416872` gives the sidebar un-settle button a tooltip.
5. `c3e37094e0` renders oversized terminal graphemes without crashing.
6. `e0b4f46390` creates threads in the background on cmd+enter.
7. `b381fdb12c` stops launcher shortcuts from hijacking the empty composer.
8. `44e4a7071d` adds external project icon selection.
9. `592c5983c1` dedupes terminal mouse motion reports.
10. `421088c273` keeps oversized thread search queries from crashing clients.
11. `035058a23e` stops a directly-saved backend from hiding its T3 Connect environment.
12. `11f051373e` records which client started each thread and turn.
13. `ce91284f83` stops marking mixed tool runs as failed.
14. `f34b9d31b3` fixes command-click on spaced folder links.
15. `2274444e92` stops pushing follow-up messages to the top.
16. `0ede2ed0de` removes a redundant release-note assertion.
17. `2c4158f87a` handles wide ordered-list marker edge cases.
18. `49c2b4471c` restores user PATH for remote SSH servers.
19. `d9c1732b27` keeps tailscale spawn defects from breaking advertised endpoints.
20. `dedcd99a9d` keeps Codex service tier labels readable.

## Conflict composition

The pre-merge `git merge-tree` simulation predicted four conflicts (all
server-side); the real merge surfaced fifteen because the simulator under-
expands rename sources and content adjacency. All fifteen were resolved by
composition; every auto-merged both-sides-touched file (32) was separately
audited against both parents with zero seam losses.

| File                                             | Composition                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/persistence/Migrations.ts`      | Both migration lines kept. Upstream's incoming `041_AuthSessionClientConnection` was renumbered to `042` because Scient already shipped `041_ProjectlessThreads`; Scient-shipped migration numbers are never reused. Expect this tail region to conflict on future syncs until upstream passes 42.                                                                                                                                                                   |
| `apps/server/src/ws.ts`                          | Both sides concatenated in both hunks: the Scient fork reactor requirement stays at layer head; upstream's analytics service, client-origin dispatch wrapper, and command-event recording land verbatim ahead of the Scient `thread.fork` completion gate (order is semantically neutral; analytics never fires for forks).                                                                                                                                          |
| `apps/server/src/server.test.ts`                 | Region rebuilt as three sequential verbatim tests: Scient's fork ready-gate, Scient's fork provisioning-failure gate, then upstream's "records thread analytics only after a client command succeeds". Staged result verified byte-exact against stage blobs.                                                                                                                                                                                                        |
| `apps/server/src/assets/AssetAccess.ts`          | Schema union keeps Scient's four claim kinds (`generated-document`, `analysis-artifact`, `environment-file-exact`, `environment-html-document`) plus upstream's `project-favicon-external`; resolver branches likewise unioned with upstream's external-favicon branch appended.                                                                                                                                                                                     |
| `apps/web/src/components/ChatMarkdown.tsx`       | Imports unioned; upstream's renamed `normalizeMarkdownLinkHrefKey` kept primary with the Scient name aliased (identical bodies); file-link lookup composed as map-get by Scient's decoded key first, upstream's direct resolution (with Scient's workspace-root argument) as fallback so spaced-folder links resolve while external-document behavior is preserved.                                                                                                  |
| `apps/web/src/components/ChatView.logic.ts`      | Pure union: Scient fork helpers plus upstream's draft-hero/background-submission helpers (names disjoint; upstream helpers are compile-required by merged ChatView wiring).                                                                                                                                                                                                                                                                                          |
| `apps/web/src/components/ChatView.logic.test.ts` | Union: Scient fork and projectless workspace-root describes followed by upstream's draft-hero transition describe.                                                                                                                                                                                                                                                                                                                                                   |
| `apps/web/src/components/ChatView.tsx`           | Import unions only; the #7821/#7897 runtime wiring had auto-merged. Internal `onSend` call sites audited against upstream's reordered signature with Scient's steer options appended as the fourth parameter.                                                                                                                                                                                                                                                        |
| `apps/web/src/components/chat/ChatComposer.tsx`  | Composed signatures place upstream's submission intent second and Scient's steer options last; Enter handling gates the Scient steer shortcut to server threads so draft threads reserve cmd+enter for upstream's background submission (`shouldSubmitComposerOnEnter`, removed upstream, is not reintroduced).                                                                                                                                                      |
| `apps/web/src/components/CommandPalette.tsx`     | Footer union renders both Scient actions ("New folder", "Open in file manager") through upstream's new `CommandFooterAction` primitive for visual consistency with the icons feature.                                                                                                                                                                                                                                                                                |
| `apps/web/src/composer-logic.ts`                 | Type block unions Scient's `"fork"` slash command (marked) with upstream's exported `ComposerSubmissionIntent`; upstream's intent function had already merged cleanly below.                                                                                                                                                                                                                                                                                         |
| `apps/web/src/composerDraftStore.ts`             | Union: Scient's `flushComposerDraftPersistence` plus upstream's three background-submission helpers; the ephemeral state field was verified present and intentionally unpersisted.                                                                                                                                                                                                                                                                                   |
| `apps/web/src/markdown-links.ts`                 | Upstream taken for both hunks (dual-capture href extraction tolerant of spaces, exported editor-open predicate). Supersede accepted: angle-bracket destinations are now returned unwrapped; behavior-neutral for Scient's consumer, one unit-test expectation updated accordingly. The custom-scheme guard is byte-identical on both sides, so `scient://` handling is unaffected. A duplicate auto-merged pattern constant was collapsed to upstream's retuned one. |
| `apps/web/src/markdown-links.test.ts`            | Union of both suites keeping Scient's lookup-key tests (with the unwrapped-destination expectation) alongside upstream's extraction and click-platform tests.                                                                                                                                                                                                                                                                                                        |
| `docs/user/keybindings.md`                       | Both paragraphs kept: Scient's projectless "Don't work in a project" explanation followed by upstream's cmd+enter background-submission exception.                                                                                                                                                                                                                                                                                                                   |

## Scient adaptations

### Background submission vs steer

Upstream's #7821 gives mod+enter a second meaning: start a draft thread in the
background and open a fresh composer. Scient's steer shortcut uses the same
chord on live server threads. The composition assigns each meaning its own
surface: drafts get upstream's background submission, server threads keep
Scient steering, and plain Enter still queues through the Scient queue strip.
ChatView owns the queue-vs-send disposition exactly as before.

### Projectless promotion handoff

Upstream's background-submission promotion resolves the destination ref
through the project-scoped helper, which rejects the null project id that
projectless drafts legitimately carry (the same class of collision as the
previous sync's bootstrap-retry fix). The merged code constructs the draft
target ref directly, preserving identical behavior for project-backed threads
and correct behavior for Quick Chat drafts.

### Migration numbering

Scient's `041_ProjectlessThreads` shipped to `main` first, so upstream's
`041_AuthSessionClientConnection` enters as `042` (files renamed, suite id and
boundary updated; column contents untouched). This mirrors the standing rule
that shipped Scient migrations are never renumbered to match upstream.

## Validation

- seam verifiers: brand check (1354 product-surface files), Quick Chat (8
  mounts, 36 reviewed projectless decision paths), analysis (10 owned roots),
  LaTeX (6 owned roots)
- full non-server workspace suites in parallel: all green, including the web
  unit suite at 389 files / 3480 tests
- full server suite across three shards: 107/106/106 files,
  935+1244+1218 tests, zero flakes
- focused runs during resolution: markdown-links, ChatView logic, and
  composer-logic (136 tests); AssetAccess plus both migration suites
  (23 tests); SessionStore (9 tests); the three rebuilt server.test.ts tests
- Rust: `cargo fmt --check` plus 15 resource-monitor tests
- `pnpm exec vp fmt --check` (one formatter reflow in ChatComposer applied)
- `pnpm exec vp lint --report-unused-disable-directives`: 16 non-blocking
  warnings (15 carried from the accepted origin/main baseline; one inherited
  from upstream's own terminal-grapheme commit), 0 errors
- `pnpm run typecheck`: 0 errors across all workspaces
- production monorepo build passed
- desktop smoke test passed
- upstream provenance verifier passed at integrationBase `be7d35aaeb`
  pre-commit
- `git diff --check` clean

No browser automation, live-data access, publication, signing, or release
action was performed.
