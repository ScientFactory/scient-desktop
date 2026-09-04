# T3 alignment through 5f878d2a

Role: frozen integration record, not a feature plan or release approval. Current
maintenance policy remains in `UPSTREAM.md` and the upstream alignment protocol.

## Exact checkpoint

- Owned base: `6b03b15d8c73d6ca010ae0a98cad67976be9a93e`, including PR #230
  (Antigravity reasoning and provider selection) and PR #231 (managed updates
  and direct-install UX).
- Previous official boundary: `fff33f9e851912363c5b1f3ac65598be35eb5f0d`.
- Frozen official target: `5f878d2a85807618a4c8571cdef5daa3124672d6` from
  `pingdotgg/t3code`; nearest tag `v0.0.39-nightly.20260904.1276`.
- Range: 102 official commits, 402 upstream-touched paths. The merge had 60
  conflicted paths; review included the automatically merged overlaps.
- Branch: `codex/t3-sync-5f878d2a-20260904`.
- History-preserving merge: `c927c346e0dc4e467634293e35fb89049270ef7a`. Its first parent is the owned
  base above and its second parent is the exact frozen official target.
- `origin` remains Scient's writable remote; upstream push remains `DISABLED`.

Work began on main after #230. While #231 was in CI, the initial pass stayed out
of Settings/provider UI. After #231 merged, canonical main was fast-forwarded,
the in-progress merge was recreated on that new base, and the saved compatible
resolutions were reapplied. No donor commits were cherry-picked or replayed.
Later upstream tips do not silently expand this checkpoint.

## Received behavior

- Antigravity ACP 1.1.1, improved auth and startup handling, project Skills,
  subagent-batch reporting, and model-inventory updates from running sessions.
- Shared runtime information describing the active harness and inline image/video
  support; Scient's additional scientific instructions and actual tool grants remain.
- Provider subscription limits, optional usage hubs, and explicitly confirmed Codex
  reset-credit redemption with account-scoped serialization and idempotency.
- Context compaction, context-window UI, and Claude resume-compaction handling.
  Provider support stays capability-driven; no new Droid/legacy capability is invented.
- Codex asynchronous questions, continuation handling, and related event persistence.
- Explicit desktop browser-login import with platform-specific keyring/native support.
- Updated Settings layout/navigation, provider/usage settings, composer behavior,
  mobile composer/media work, and preview positioning/presentation fixes.
- Git/PR discovery, refresh and display improvements, sidebar icons, OpenCode child
  session cleanup, connection diagnostics, and desktop/service reliability work.
- Native build prerequisites, release-verification support, and a manual Windows
  test lane. This does not activate a release or change Scient's release policy.

## Conflict composition and semantic review

### Providers and the incoming owned changes

The managed runtime catalog, process-lifetime managers, direct Install/Update,
latest-qualified Repair, Remove, sign-in, system/custom installations, and
passive-probe rules from #231 are preserved. The separate Antigravity reasoning
selector and exact native model identities from #230 remain intact.

T3's new Settings sections/rows are adopted while retaining Scient's models-first
tabs, compact assisted actions, operation progress, and independent provider-row
selection hit area. The switch does not consume ordinary row selection. An
unavailable provider definition falls back to Configuration instead of an empty
Models tab. Searchable shared settings and per-environment read-only boundaries remain.

The native Antigravity binary, bundled catalog, and shared registry floor now all
identify the verified 1.1.1 release. The registry version was checked against
[the exact official registry revision](https://github.com/agentclientprotocol/registry/blob/81bf71b55e15f630c4fb8a86d20d3088071d2071/antigravity-acp/agent.json).
Regression tests reject catalogs below that floor and compare bundled artifact
digests across all five supported targets. The older publication catalog remains
historical data; this alignment does not publish a feed or mutate installed CLIs.

The ACP config-update refactor retains Scient's lenient empty acknowledgments and
Droid's option-specific notification transport. Concurrent authoritative inventory
notifications are not erased by empty replies; successful local acknowledgments
also publish the new upstream `ConfigOptionsUpdated` event. Tests cover both paths.

Codex uses one upstream app-server spawn/handshake implementation. Scient's thin
compatibility entry point delegates to it, retaining explicit environment isolation
for connection and qualification callers. Usage/credit probes use the resolved
instance account home, not an arbitrary other installation. Claude and OpenCode
compose the new runtime information with Scient awareness without duplicate
`system` properties or fabricated tool availability.

### Conversation and preview continuity

Compaction uses the upstream lifecycle before normal Scient fork bootstrap, and
regular turns still retain fork reservation/completion semantics. Persistent
questions, reset-credit confirmation, and new optional usage streams keep their
upstream request/receipt ownership. Old clients do not receive unrequested usage-hub
events; sources and credentials stay server-owned.

Scient's projectless/fork rows, citations, images, media, rich Markdown, editable
file surfaces, and content-direction behavior remain. The promptless-restart
timeline rule treats consecutive native turns as one visual response; tests now
include a real intervening user message when verifying Fork on an older response.

Browser preview code discriminates browser versus static-artifact mini-player
state. Explicitly suppressed agent previews do not close unrelated static figures.
Scient retains its movable fixed-viewport figure/browser card, keyboard controls,
eight resize handles, and static-image path while adopting the new browser layer
ordering and presentation policy. This is an owned layout seam, not a redesign.

T3 now preserves explicit address-bar URLs. Project-script previews are different:
their localhost URL belongs to the selected environment. That caller uses the
existing discovered-server resolver, keeping remote previews on the remote host
without undoing the upstream address-bar fix. The remote regression test passes.

New-thread navigation continues to use Scient's router-scoped intent coordinator;
delayed project reads cannot override newer navigation. The upstream regression
test now emits the router's actual invalidation event instead of only mutating a
mock URL. Context-window derivation has one owner rather than duplicate state.

### Protected boundaries and documentation

Product copy remains Scient; package/protocol/env/storage compatibility identifiers
remain unchanged. Sources, Skills, analysis, LaTeX, and onboarding mount checks are
part of the gate. Scientific PDF/voice/native resource staging remains alongside
the new Linux browser-secret helper and keyring dependency.

Cloud, telemetry, updater, signing and publication authority are unchanged. Linux
service diagnostics use Scient's existing service identity. The new Cursor hygiene
webhook job is explicitly disabled; it is not an approved Scient data integration.
The Windows lane is manual-only and uses the existing GitHub-hosted Windows 2025
runner family, not a new Blacksmith dependency. Release workflow changes only add
the browser-secret build prerequisites, retaining manual/exact-commit/publication
approval gates.

User docs were updated in their existing owners for Antigravity, browser import,
composer, service, remote access, source control, tool activity, and providers.
No planning document or PR-only screenshots are committed.

## Verification and remaining acceptance

Passed on the composed source represented by merge `c927c346e0dc4e467634293e35fb89049270ef7a`:

- Focused ACP/provider, Claude/relay/service, and web navigation/preview/timeline tests.
- `pnpm run test`: 15,359 tests passed across 1,406 files; 62 tests / 10 files
  skipped under existing suite configuration. This includes 5,079 server and
  5,026 web tests.
- Full workspace typecheck, lint, formatting, build, and desktop smoke.
- `pnpm run release:smoke`, `pnpm run brand:check`, and analysis/onboarding/
  Skills/LaTeX seam checks.
- Documentation formatting, local links, and the documentation checker tests.
- Merge-parent guard unit tests. The final receipt commit also runs exact
  official/owned ancestry verification and cached/working diff checks.

Lint and Effect diagnostics retain warnings/suggestions; passing is not a
claim of a warning-free repository. No assertion was removed to make a failure
pass: obsolete fixture expectations were composed with the received behavior,
and the remote-preview and catalog-floor defects were fixed.

No interactive app, real browser profile import, live account login, credit
redemption, or production data access was performed. Physical mobile behavior,
Windows/Linux native execution, signing/notarization and publication are not
claimed by the macOS local gate. Mobile native static discovery ran, but SwiftLint,
ktlint and detekt were unavailable locally; their absence is not a pass claim.

The candidate remains a draft for an isolated-app interaction review: Settings
selection/managed operations, Antigravity model and reasoning changes, context
compaction/questions, rich media/floating previews, browser import, and remote
project-script preview. Automated checks do not establish visual acceptance.
Canonical main is synchronized to the owned base, not to this unaccepted candidate.
Merging to main, publishing a release and removing this review worktree require
their separate acceptance gates.
