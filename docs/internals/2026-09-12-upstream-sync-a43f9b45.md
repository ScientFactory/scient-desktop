# T3 alignment through a43f9b45

Status: superseded as the interim qualification point of the same candidate by the
[20363c32 receipt](2026-09-13-upstream-sync-20363c32.md).
This is one complete, bounded alignment, not a selection of upstream changes.

## Frozen history

- Owned base: `b9f26396fbf1754c16ecb50753c5e01a2232a36c`.
- Previous official integration: `f814983c262b42bd79247bae377a709925c70d63`.
- Official target: `a43f9b45ae85caf37e0be8270ad3d27365ece2bd`.
- Official range: 83 first-parent commits.
- Target describe: `v0.0.41-nightly.20260912.1599-4-ga43f9b45ae`.
- Branch: `codex/t3-sync-a43f9b45-20260912`.
- History-preserving merge: `433a23e653246c65c68aadce50a04657117eb341`, with the owned base and exact
  official target above as its first and second parents.
- `upstream` remains fetch-only (`https://github.com/pingdotgg/t3code.git`, push `DISABLED`).
- Canonical owned main was rechecked against fetched `origin/main` before the worktree was created;
  both were at the owned base.

## Adopted upstream behavior

| Area                            | Included behavior                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer and context            | Typed file, image, terminal, pull-request, preview-annotation, and clipboard context references; attachment chips; draft preservation while compacting; queued sends during compaction; PR selections in new drafts                                     |
| Chat and performance            | Incremental Markdown and code highlighting; completed-prefix reuse; stable huge-thread switching; reduced message-sync, sorting, date-formatting, minimap, sidebar-background, and PR workspace-scan work                                               |
| Devices and previews            | iOS Simulator and Android Emulator hosts; SSH and multi-host targeting; concurrent device sessions; floating device streams; recording state; composer-aware placement; browser favicons; fullscreen media continuity; persistent snapshot preview size |
| Settings and models             | Environment/project settings scopes; project overrides; default permissions for new threads; qualified Codex model IDs; updated built-in defaults; upstream-shaped provider settings; open-source license notices                                       |
| Conversation and source control | Rewind while retaining workspace changes, provider history, and prompts; PR summary/control improvements; rename detection; environment-aware command results; root/Windows Zed links                                                                   |
| Desktop and mobile              | Shared macOS permission setup; preview keystroke isolation; reliable quit hold; mobile composer/Markdown/tablet stability; Hermes thread-opening fix; pinned mobile audio dependency                                                                    |
| Usage and presentation          | Limits-first usage view; live countdown refresh; explicit unpriced-model reporting; compact right-panel surface menu; platform file-manager icons and smaller interaction refinements                                                                   |

All official commits in the frozen range remain literal ancestry. Open upstream pull requests and
later commits are outside this alignment.

## Conflict composition and review findings

The initial merge reported 99 textual conflicts. Both stages and the important auto-merged overlap
surfaces were reviewed; the result keeps upstream structure wherever possible and confines Scient
policy to existing seams.

- **Context references and rich chat:** adopt upstream's typed context-reference pipeline across
  contracts, clipboard, composer, server, desktop, and mobile. Preserve Scient citations,
  document/source attachments, rich fences, PDF/LaTeX/compute surfaces, queue/steer behavior, and
  fork semantics. Restore the citation-chip remove action that an auto-merge dropped.
- **Preview, device, and scientific artifacts:** use the upstream tagged mini-player store and shared
  floating chrome for browser and device sources. Extend the same tagged union with Scient's static
  artifact descriptor rather than retaining a parallel player. Update the Scient analysis seam to
  verify the new shared selector instead of an obsolete browser-only variable.
- **Settings:** preserve Scient's navigation order, onboarding, providers, Custom Models, Skills,
  Voice, Sources, and Scientific Computing presentation while adopting upstream environment/project
  scoping and default-permission machinery. Existing Scient defaults remain authoritative. The
  shared switch retains `aria-checked` for controlled non-mixed switches.
- **Providers and models:** preserve assisted install, authentication, managed/system runtime paths,
  subscription presentation, custom-model support, and capability-aware Scient instructions. Adopt
  qualified model IDs, rewind restoration, and current shared provider mechanics. Correct the
  provider model section so providers such as Pi do not advertise unsupported custom models.
- **Server and clients:** adapt Scient HTTP clients to upstream's grouped authenticated client while
  retaining their explicit authorization groups. Preserve asset limits and restore workspace-asset
  `sourcePath`. Keep nullable historical projects safe on mobile and server paths.
- **Persistence:** Scient migrations 51-53 and the retired development reservation at 50 remain
  immutable. Upstream's composer-context migration is registered as Scient migration **54** and is
  tested from prior states and on repeated startup; no existing ID or ledger row is reinterpreted.
- **Desktop identity:** adopt upstream macOS permission helpers and preview behavior with Scient's
  product name, packaged icon, isolated development state, and permission wording. No production
  identity or state root changed.
- **Licenses and dependencies:** adopt upstream's generated third-party notice surface. Exclude both
  T3 and Scient first-party workspace namespaces, add audited notice metadata for Scient's external
  dependency set, and test the Scient exclusion. This fixes the production build without bypassing
  notice validation.
- **Tests and generated sources:** regenerate the lockfile and route/build artifacts from composed
  sources. Update assertions only where the contract deliberately changed; no test, timeout, or
  safety check was removed to obtain a pass.

## Protected boundaries

No cloud, relay, telemetry, mobile publication, updater, signing, notarization, tag, npm, release,
or deployment authority was enabled. Scient product identity, isolated state roots, provider
lifecycle, agent-awareness capabilities, Sources, Skills, voice, analysis, compute, PDF, LaTeX,
rich Markdown, and release holds remain. Upstream marketing redirects and metrics remain ordinary
upstream ancestry and do not alter Scient's publication surfaces.

## Qualification

- `pnpm exec vp fmt --check`, `pnpm exec vp lint --report-unused-disable-directives`,
  `pnpm typecheck`, `pnpm build`, and `pnpm knip:check`: passed. Lint and Effect diagnostics contain
  advisory warnings but no errors.
- Final `VITEST_MAX_WORKERS=2 pnpm test`: all 27 workspace tasks passed. This includes 7,380 web
  tests, 6,523 server tests, and 1,386 desktop tests; explicit existing skips remain.
- Desktop smoke, release smoke, brand verification, and mobile native static checks: passed.
  SwiftLint, ktlint, and detekt were unavailable and were reported as skipped by the mobile check.
- Analysis, onboarding, Skills, and LaTeX seam checks: passed against the exact official target.
- Focused migration compatibility, grouped Scient HTTP clients, device/browser authorization,
  preview mini-player/static artifacts, provider awareness, usage refresh, and third-party-license
  tests: passed.
- Repository integrity checks found no unresolved index entries, conflict markers, malformed diffs,
  or whitespace errors.
- No computer use, live-provider message, Android/iOS device test, Linux/Windows runtime test, push,
  PR, main merge, release, or publication was performed.

## Owner manual review

Use the isolated candidate app and synthetic state supplied from this exact branch.

1. Open a local project, create and switch conversations, send and retry a message, fork, queue or
   steer a follow-up, and rewind a disposable conversation. Confirm drafts and provider selection
   survive the corresponding transitions.
2. Attach files and images; add terminal, pull-request, and preview-selection context; verify chips,
   removal, pasted context, and sent-message previews. Exercise Markdown, code blocks, tables,
   images, audio/video, PDF, LaTeX, Sources, and Compute surfaces.
3. Open browser and device panels, move a supported surface into the floating player, resize/move it,
   and return it to the right panel. Check recording state and that preview keystrokes do not reach
   the composer.
4. Review Settings at environment and project scope, including overridden values, default
   permissions, Providers, Custom Models, Skills, Voice, Scientific Computing, and open-source
   licenses. Confirm provider subscription/email layout and supported custom-model controls.
5. Review sidebar project search, grouping, pinning, scrolling, settled states, usage limits and
   countdowns, PR panels/actions, file rename display, and the macOS permission setup flow.

This receipt does not authorize a push, pull request, main merge, release, or publication. Owner
visual and interaction acceptance remains a separate gate.
