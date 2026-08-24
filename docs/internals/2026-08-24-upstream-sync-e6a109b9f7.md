# T3 upstream sync through e6a109b9f7

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Exact boundaries

- Owned base: `118420c908594f0d9ca3124d341a5ce47cc3505a`
- Previous literal T3 boundary:
  `b1670ac7d9b5b7bb9d7ebd969f27384daee22813`
- Integrated T3 target:
  `e6a109b9f74552eb735968986845e500b98c3c73`
- Official tag at the target: none (nearest description:
  `v0.0.34-nightly.20260824.1175-17-ge6a109b9f7`)
- Exact donor range: `b1670ac7d9..e6a109b9f7`, 31 commits
- History-preserving merge:
  `e171978fb28c93de86ed395d048856f430d02119`
- Integration branch: `codex/t3-sync-e6a109b9-20260824`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The merge commit has the exact owned base and official target as its parents.
No cherry-picks, replayed donor commits, feature-branch work, or user-data
operations entered this lane. `integrationBase` advances to the merged target;
`reviewedThrough` remains a separate cursor because this synchronization did
not re-review T3's product decisions.

## Adopted behavior

- Composer images upload through authenticated, bounded server attachments
  before a turn is sent. Failed sends clean up pending uploads, while Scient's
  durable message queue keeps self-contained images that can survive a restart
  and return to the composer for editing.
- Codex surfaces app-access elicitation approvals, provider interruption
  failures recover to a truthful stopped state, missing worktrees are recreated
  before a turn, and already-removed worktrees no longer make thread deletion
  fail.
- OpenCode permission and skill discovery are safer; provider snapshots retain
  authoritative subagent models; and the CLI entrypoint works on supported Node
  versions that do not expose `import.meta.main`.
- The composer receives the maintained skills menu, spacing, dark-theme badge,
  approval, work-log, and follow-up-layout fixes. Usage, pull-request, terminal,
  sidebar, desktop release-note, mobile thread, and Git reliability changes are
  retained as ordinary upstream behavior.
- Pull-request deployments remain disabled in the inherited marketing
  configuration.

## Conflict composition and compatibility adaptations

Nine textual conflicts were composed explicitly. The result keeps inherited
host behavior upstream-shaped while retaining narrow Scient authority.

- **Repository governance:** T3 contributor-vouch entries remain in ancestry
  but do not change Scient's deliberately owner-scoped trust list.
- **Assets and RPC:** upstream attachment upload/delete schemas, authorization,
  HTTP routing, RPC handlers, and failure cleanup sit beside Scient's
  range-capable asset delivery, environment-file capabilities, scientific
  artifacts, and browser-PDF publication. None replaces another.
- **Version skew:** upstream semver-aware directionality is retained with the
  Scient product name in user guidance.
- **Contracts and lockfile:** attachment tests are combined with Scient asset
  tests. The generated lockfile keeps Scient's `fff-node` patch and Lexical
  dependency while adopting the updated upstream Legend List patch.
- **Queued images:** upstream uploaded attachment IDs are intentionally used
  only for an immediate send. Scient queue entries keep inline image data so
  they remain durable and editable after a restart.
- **Projectless historical data:** upstream worktree recovery accepts the
  nullable project identifier still required by Scient's immutable historical
  event decoder, and simply skips recovery when no current project exists.
- **Entrypoint portability:** both module and entry paths are realpathed before
  comparison so npm/npx symlinks also work on macOS, where `/tmp` can resolve to
  `/private/tmp`.

## Protected-boundary audit

- Scient identity, `scient-next` storage compatibility, protocols, preview
  partitions, client persistence, and legacy-data policy remain intact.
- Analysis, LaTeX, local voice, onboarding, browser-PDF export, scientific
  sources, provider lifecycle, durable forks, message queue, and assisted
  provider mounts remain present.
- Telemetry, OTLP, cloud, relay, service activation, updater authority, signing,
  release promotion, and publication gates remain unchanged. T3's marketing
  change explicitly disables pull-request deployments.
- No incoming commit changed a Scient-owned `apps/**/scient` implementation
  root. All affected Scient seams were audited in their inherited hosts.

## Verification

Local non-visual verification used Node `v24.19.0` and pnpm `11.10.0`:

- Conflict and semantic-overlap tests passed, including assets, version skew,
  attachment upload, queued messages, provider command recovery, Codex, Claude,
  and Scient fork behavior.
- `pnpm run typecheck` passed across all 25 typecheck lanes; suggestion-only
  diagnostics remain.
- `pnpm exec vp fmt --check` passed across 3,576 files.
- `pnpm exec vp lint --report-unused-disable-directives` passed with inherited
  warnings and no errors.
- The full non-server test lanes passed. After correcting the macOS symlink
  normalization exposed by the first run, the complete server lane passed 333
  files and 3,579 tests, with 5 files and 27 tests skipped.
- `pnpm run build`, `pnpm run test:desktop-smoke`, `pnpm run release:smoke`,
  and `pnpm run brand:check` passed.
- Onboarding, LaTeX, and analysis seam verifiers passed.
- Exact upstream ancestry and `git diff --check` passed.

No browser automation, screenshots, visual acceptance, live provider action,
release publication, signing, or platform packaging was performed.

## Publication boundary

This merge does not publish artifacts, modify `release/stable`, or enable T3
relay, cloud, hosted web, mobile store, signing, updater, npm, tag, nightly, or
release authority. Those remain explicit Scient gates.
