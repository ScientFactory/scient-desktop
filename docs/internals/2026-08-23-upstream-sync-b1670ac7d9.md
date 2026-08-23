# T3 upstream sync through b1670ac7d9

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Exact boundaries

- Owned base: `2bb6d79b0c0c2a0bc515ac4583918613b991ca5e`
- Previous literal T3 boundary:
  `dedcd99a9d16240327ce763b885b326aff607bdb`
- Integrated T3 target:
  `b1670ac7d9b5b7bb9d7ebd969f27384daee22813`
- Official tag at the target: `v0.0.34-nightly.20260823.1169`
- Exact donor range: `dedcd99a9d..b1670ac7d9`, 16 commits
- History-preserving merge:
  `b2d121b205dcb0eff115d27015235fb5033f94bd`
- Integration branch: `agent/t3-sync-b1670ac7d9-20260823`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The merge commit has the exact owned base and official target as its parents.
No cherry-picks, replayed donor commits, feature-branch work, or user-data
operations entered this lane. `integrationBase` advances to the merged target;
`reviewedThrough` remains a separate cursor because this synchronization did
not re-review T3's product decisions.

## Adopted behavior

- Workspace-file images render through authenticated assets across clients,
  with mobile dimensions preserved and unsupported image sources blocked.
- Opening and terminal responses stay visible; tool activity no longer leaves
  a blank thread viewport; recovered tool failures no longer keep work logs
  red; and settled pinned threads move into the settled section.
- Appearance contrast is adjustable through T3's settings and token pipeline.
- Completed Codex work no longer remains stuck, Claude Stop closes lingering
  work, remote update credential failures reconnect, and repository actions use
  the remote's default branch rather than assuming `main`.
- Codex `/feedback` uses T3's explicit user command and upload contract.
- Release builds reuse the resource monitor, reduce Windows dependency-cache
  weight, omit unused Claude SDK executables, and package only the target
  Windows native architecture.

## Conflict composition

The merge produced 11 textual conflicts and one additional semantic overlap.
The result follows the thin-fork rule: equivalent host behavior stays
upstream-shaped, while product-specific Scient authority remains narrow.

- **Release:** Scient's manual exact-source, signing, assembly, and publication
  graph remains authoritative. T3's dependency and resource-monitor caching,
  package pruning, target-architecture filtering, and build-script changes are
  adopted inside that graph. T3's npm, relay, nightly, and tag publication
  authority is not substituted for Scient's release workflow.
- **RPC and authorization:** T3's provider-feedback RPC, server route, client
  command, and operate scope are added beside Scient's browser-PDF export and
  other scientific capabilities. Neither capability replaces the other.
- **Provider tests:** the shared server test layer uses T3's feedback service
  mock while retaining Scient's managed-provider lifecycle methods.
- **Chat lifecycle:** T3's Codex feedback flow and active-turn fallback are
  adopted. Scient's standalone fork command, provider-availability guard,
  durable fork callbacks, and scientific chat mounts remain composed around
  the same inherited send and timeline paths.
- **Sidebar:** T3's settlement-before-pinning classification and persistent pin
  marker are adopted in Scient's already-hoisted row renderer. Quick Chat keeps
  its slim presentation, product title, and project-only pull-request guard.
- **Markdown images:** one renderer now applies T3's source classification,
  absolute/file/UNC handling, direct-image sizing, signed-asset fallback, and
  blocked-source behavior. Scient's richer card remains for supported relative
  workspace images, where it supplies open, copy, download, refresh, background,
  and expanded-preview actions. The duplicate auto-merged renderer was removed.
- **Documentation and lockfile:** Scient's product-specific release and Quick
  Chat documentation remains authoritative while incorporating the incoming
  behavior. The lockfile retains Scient dependencies and applies only T3's
  bounded Claude platform-package removal.

## Protected-boundary audit

- Scient identity, `scient-next` storage compatibility, protocols, preview
  partitions, client persistence, and legacy-data refusal were untouched.
- Telemetry, OTLP, cloud, relay, service activation, updater authority, signing,
  release promotion, and publication gates remain unchanged except for the
  bounded build-cache optimizations described above.
- No upstream commit touched a Scient-owned `scient/` implementation root.
  Quick Chat, onboarding, LaTeX, analysis, browser PDF export, provider
  lifecycle, typography, and local voice remain narrow mounts on the inherited
  host.
- T3's Macroscope configuration is retained as ordinary upstream ancestry. It
  does not replace Scient's owner decision, review, verification, or merge
  authority.

## Verification

Local non-visual verification used Node `v24.19.0` and pnpm `11.10.0`:

- Conflict-focused web tests: 8 files, 171 tests passed.
- Conflict-focused server, provider, RPC, client-runtime, contract, and release
  tests: 12 files, 482 tests passed.
- Mobile, Quick Chat, browser-export, and Markdown-classifier tests: 5 files,
  94 tests passed.
- `pnpm run typecheck`: passed across all 25 typecheck lanes; suggestion-only
  diagnostics remain.
- `pnpm exec vp fmt --check`: passed across 3,568 files.
- `pnpm exec vp lint --report-unused-disable-directives`: passed with inherited
  warnings and no errors.
- `pnpm run test`: passed across all 24 test lanes. The web lane passed 425
  files and 3,693 tests; the server lane passed 327 files and 3,503 tests with
  5 files and 27 tests skipped.
- `pnpm run build`, `pnpm run test:desktop-smoke`, `pnpm run release:smoke`,
  and `pnpm run brand:check`: passed.
- Quick Chat, onboarding, LaTeX, and analysis seam verifiers passed.
- `git diff --check`: passed.

No browser automation, screenshots, visual acceptance, live provider upload,
release publication, signing, or platform packaging was performed.

## Publication boundary

This merge does not publish artifacts, modify `release/stable`, or enable T3
relay, cloud, hosted web, mobile store, signing, updater, npm, tag, nightly, or
release authority. Those remain explicit Scient gates.
