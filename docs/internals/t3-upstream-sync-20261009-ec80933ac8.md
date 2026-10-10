# T3 upstream alignment — 160 commits through bd2346eda2

This candidate preserves literal official history and current Scient product boundaries.
Source qualification, maintainer structural review, hosted CI and visual acceptance are separate.
This record does not authorize merging, release or publication.

## Original 43-commit boundaries (historical)

| Input                        | Exact revision                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Original owned base          | `0cf6e0bd85c3d6be221b70164d2601e0b8e83e15`                                                           |
| Previous official boundary   | `2a93885bac5798a79d55069a0b5dc3e53c6176bc`                                                           |
| Final frozen official target | `ec80933ac8cd02fec5c97b342462ccc9567cdb1e`                                                           |
| Initial official merge       | `0aa746831ef0e97f8ba56f2230124a373fce0079`, second parent `101f8b2f55df50d4f8d70ed8e6b8e0edf71a2f31` |
| Official extension merge     | `eaa42295c2271f7b92acd7857615391dd54e783c`, second parent `ec80933ac8cd02fec5c97b342462ccc9567cdb1e` |
| First owned-main catch-up    | `6b2ad83b48a313431287fd5d6e5e88fe2b8e86ea`, second parent `6f4271e5e500fdbbeb5266f8b2a815bff1af8d96` |
| Final owned-main catch-up    | `5e99e854ad7fb98164049899dfc55356e53c70fc`, second parent `b631232d51fa6705a72e3f0021cee139999c6b69` |
| Branch                       | `codex/t3-sync-101f8b2f55-20261009`                                                                  |
| Tag relationship             | No exact target tag; nearest `v0.0.46-nightly.20261009.2861`                                         |
| Fetch-only boundary          | Official `pingdotgg/t3code`; upstream push URL `DISABLED`                                            |

All 43 first-parent commits in the following inventory remain unchanged in ancestry.
Neither held activation nor Scient composition drops official commits.

## Integrated advancements

### Composition by behavior

- **Provider packages:** adopt core/testing, Pi, Muse, OpenCode, Cursor, ACP, Grok and ACP Registry extraction and the service-yielding factory SPI. Preserve OMP and Droid, configured instance IDs, native receipts, canonical tool projection, provider awareness, selected Skills and the approved managed-runtime and registry provisioning paths. Package generic prompts retain official defaults; Scient supplies its instruction copy at typed application composition seams.
- **Pi, Claude and native sessions:** retain every selected skill and complete current prompt content; reconcile retained native turn rewinds without rewriting frozen inherited fork history. Closed transports reject before writing. Claude passive authentication classifies logged-out CLI state honestly; the MCP token leaves process arguments.
- **Thread and queue integrity:** adopt faster long-thread message sync and upstream session lifetime mechanics. Preserve Scient bounded history, fork-by-reference ownership, exact-attempt queue holds, accepted Resume receipts and established send/release ordering. Session retirement closes the actual owned scope and blocks replacement until persistence and physical close settle.
- **Browser and previews:** adopt normal environment-hosted tab behavior, fullscreen/shortcuts/link/reload handling, local desktop tabs for remote environments, first-message media/HTML/PDF previews, safe download and fragment navigation. Keep explicit browser ownership, workspace/asset authorization and private-host favicon withholding. Preserve scientific image metadata and BiDi when raw HTML is disabled.
- **Clients:** preserve Scient settings/environment scopes, compute and document owners, provider setup/managed actions and Pi presentation while adopting upstream layout, timeline, folder-spinner, branch-setting hint and mobile status/image fixes. Legacy persisted provider-map decoding survives; new writes use provider instances.
- **Connectivity and desktop:** retain session permissions/lifetime checks, relay update continuity, cancellable install locks, Windows retry handling and bounded cloudflared download. WARP/shared-CGNAT addresses are not called Tailscale without interface/IPv6 evidence. Desktop shutdown cancels backend pipe reads. The CLI warns rather than installing behind another existing command.
- **Current owned-main improvements:** retain Markdown in-place rename/lease semantics, pending importer repair and the Windows native payload qualification contract. No new signing, release, telemetry, hosted or mobile distribution authority is activated.

### Complete official inventory

| Commit                                     | Advancement                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `bd565bd1794f49f176ad137555faa46224716138` | fix(shared): relay client install waits out a brief Windows file lock (#16998)                                             |
| `c377d1ca17dbce42008fbb05fccd95468b13d329` | fix(shared): release relay install locks on cancellation (#10585)                                                          |
| `af3d842a001d030ed528396bf59cf02bbf373cd0` | chore(shared): bump managed cloudflared to 2026.10.0 (#11184)                                                              |
| `580948708b66f2a971199670f76cb6b43119e9a4` | fix(shared): bound cloudflared download with 10-minute timeout (#14139)                                                    |
| `9eea28bacd27b2ee6d5183e195c397bba8b515a0` | refactor(provider-core): add provider-core and provider-testing packages (#17299)                                          |
| `2c1160783ea4b4dcc1c1f1ab04639ffc0aaa289d` | refactor(settings): drop the legacy per-driver providers map (#17300)                                                      |
| `9b0df1358f9f9c3277bcb33777c2435b88ee75c4` | refactor(provider-pi): move Pi into its own provider package (#17302)                                                      |
| `7b57b723d3b7490b50fffbd99fe89c6aa98fae1f` | feat(models): tell users when a CLI update unlocks a new model (#17307)                                                    |
| `48b71f0eb323d08c8fcadfe54adf34becb2984da` | fix(web): collapsed composer reserves room for wide send actions (#17016)                                                  |
| `d81afa0a6f403bd6e5562ffcee2484089a1fdc3f` | fix(muse): workflow subagents no longer stall on hidden approvals (#17329)                                                 |
| `e38b6a188fafd499df347331f8c8279ff320c207` | refactor(provider-core): share attachment prompts, notifications, and event loggers (#17330)                               |
| `741377ce5fb1578916659cbb93fd403b26dbeb62` | fix(web): file previews handle downloads, in-page links, and repo paths, and favicons stop leaking internal hosts (#16950) |
| `5754121c23f73201d47a96feb97eca7b96334a2a` | fix(server): environment-hosted browser tabs behave like a normal browser (#16963)                                         |
| `d9f7c0caed5cc0fe84cec97f2b6f002084542a4e` | fix(desktop): browser tab fixes for fullscreen, shortcuts, links, reload and hidden tabs (#16961)                          |
| `66298aa926e6a4c95ebecbc576a68634315899c0` | fix(web): desktop opens remote environments' browser tabs locally (#17316)                                                 |
| `3bfbc37dbf37095816eda500f3f1e05cb98bb95b` | fix(desktop): the t3 command warns instead of installing behind another t3 (#17351)                                        |
| `e0c80c198cfbb2afe04528cd6a7ec1d2f21606dd` | fix(web): images, video, HTML and PDF preview in a thread before its first message (#17352)                                |
| `5b78b34bba8645a268900f946858ea1470621c41` | refactor(provider-muse): move Muse Code into its own provider package (#17331)                                             |
| `6308db4ff500b89821e22605f964b1701cead8ee` | fix(web): semantic branch naming hint lines up with its setting (#16972)                                                   |
| `393ff4c968073d8419e5bade06000998602af6ad` | fix(mobile): restore chat image previews in the v5 stack (#17361)                                                          |
| `c724c7cb02aaeb0a23ff6e5e224d17c0fdb9a36b` | feat(mobile): fade working threads and match web's status labels (#17368)                                                  |
| `dbd83435347d13d5f456271f4f1f5efe294a111d` | fix(server): agent browser tools stop bloating history, fall back sensibly, and respect ownership (#16956)                 |
| `29980a31409234b676f97bd477c4e46fdb61a929` | fix(web): add room for thread timeline markers (#17372)                                                                    |
| `b0ee7dd48f868c5c02884345f723bebaf616b13d` | fix(web): drop sidebar context before cancelling pointer drag (#17373)                                                     |
| `2c7a446e657e705c257db28540819f4c0115b2fc` | refactor(providers): namespace-import service modules in core, Muse, Pi, and testing (#17375)                              |
| `456930a09db29efdd3d4a397fe214e9ede2d6975` | fix(auth): show connection permissions and enforce session lifetime (#17370)                                               |
| `e62161bc5b53389a462d066836d47d25df0f4134` | refactor(provider-opencode): move OpenCode into its own provider package (#17345)                                          |
| `b5e4f1e0b0c2c06f183ab6a89072bec21c8334c4` | refactor(provider-cursor): move Cursor into its own provider package (#17349)                                              |
| `664bd5e524bb58b23ecab0f2e413fc2ecb4caf55` | refactor(provider-acp): move the shared ACP adapter into its own package (#17354)                                          |
| `b707eeb052782cfd8b1ff0445f84b2aaf01da38b` | refactor(provider-grok): move Grok into its own provider package (#17357)                                                  |
| `42c6623d492850c747b7ba06c1d0f1e1559d0ad5` | fix(server): speed up long thread message sync (#17387)                                                                    |
| `c9fa1367caff4cd6595386814e1f8bb950d3d3ef` | fix(desktop): cancel backend pipe reads to avoid slow shutdown (#17386)                                                    |
| `b000eac171318bf0130865387ae33523eecd3019` | refactor(providers): adapter factories yield their services (#17381)                                                       |
| `5785df19ea748be0755244582cb70d785f95f830` | fix(web): show a row spinner instead of a banner when expanding a folder (#17378)                                          |
| `8f760371978f05b49e6f6b6aa4b2c523ab14b4fe` | fix(server): a timed-out browser drag no longer exits the server (#17360)                                                  |
| `563645cf6e104ad930f4c9b209678a77eef07e65` | fix(server): a logged-out Claude CLI no longer reports as authenticated (#15459)                                           |
| `3b6af0bd1600f034b0466e1b8ff017fbabeba910` | fix(server): Pi loads every selected skill without losing prompt text (#17194)                                             |
| `c908cea52510ed29199c3cc477204da425601301` | fix(server): keep the Claude MCP token out of process arguments (#17408)                                                   |
| `7a2b1c72beed4f560aebb41aa7b26e0792eeb938` | fix(server): reconcile Pi native session rewinds (#13839)                                                                  |
| `cb46c62504aca99295a4a8879644625a20685b7f` | test(provider-pi): cover continuation offers through the driver (#17407)                                                   |
| `43f8a8de17a7ac1baa7a3cf36d681856de2d8add` | refactor(provider-acp-registry): move the ACP Registry into its own package (#17405)                                       |
| `101f8b2f55df50d4f8d70ed8e6b8e0edf71a2f31` | fix(server): relay client updates no longer drop the host off T3 Connect (#17366)                                          |
| `ec80933ac8cd02fec5c97b342462ccc9567cdb1e` | fix(connect): Cloudflare and other VPN addresses no longer show as Tailscale (#17158)                                      |

## Meaningful composition and repairs

The initial range had 82 conflicted paths. Resolutions adopt the new provider/package
structure and retain Scient policy at application composition boundaries rather than
keeping superseded app-owned provider implementations beside it. Clean overlaps and
untouched consumers of changed shared APIs received source review as well.

- Provider routing uses configured instance IDs and preserves unknown-versus-default
  distinctions. Environment requirements remain truthful; no casts erase service
  dependencies to make compilation pass.
- Legacy importer pending retries append deterministic repairs for validated message
  and item IDs. Invalid siblings remain pending; completed history and immutable
  migration identities are not rewritten. The fresh-import path avoids repair reads.
- A controlled retained-native-turn rewind race exercises the production event-ingestion
  route. After a source rewind, the selected fork still owns its planned inherited
  content. This is synthetic Codex-fixture proof of shared ingestion, not live Pi proof.
- Extracted package roots are included in the existing provider qualification workflow;
  its stale retired stream glob is removed. Qualification protections are preserved.
- Application provider fixtures exercise the Scient bridge/copy used in production.
  Generic package defaults are deliberately upstream defaults. ACP replay mismatch closes protocol input
  and output so the child exits with its recorded failure rather than hanging.
- The no-raw Markdown branch composes the existing safe image plugins plus upstream
  heading IDs. Raw parsing/sanitizing remain opt-in, and BiDi is still appended. Render
  tests cover escaped script markup, RTL arrows and the standalone loading figure.
- Compute tests consume the shared primary environment and explicitly grant only the
  local settings-write scope. AppRoot includes the upstream BrowserProfileReporter;
  Grok tests assert actual light/dark glyph colors rather than obsolete CSS spelling.

- Native qualification found a dropped Codex trusted skill suffix after the shared attachment
  helper extraction. The app formatter now supplies complete captured input, attachments and
  that suffix once; current overflow still rejects before the native offer.
- Physical scope close joins its original owner. The initial public waiter shares one
  30-second budget for persistence and close, while late completion/failure remains owned
  and blocks replacement, configuration and logout. Native-child tests cover interrupted
  waiters, timeout, credential revocation and late failure without relaxed assertions.
- Claude native query assembly forwards the same capability-scoped awareness used by its
  reuse key. The upstream credential environment placeholder and read-only allowlist remain.
- Pi's identity tool map was unnecessary and introduced a native ESM cycle through the
  operation catalog. Removing that import uses the extension's canonical-name fallback;
  actual Node imports and memory tests exercise this boundary.
- Pi recording reconciliation preserves the original full-file SHA-256 receipts. Only the
  official lazy `get_commands` discovery pairs disappear from live schedules; no prompt,
  tool result, abort or history bytes are rewritten. The original recordings reconstruct
  independently of Git checkout depth. The Pi replay binding now derives its private
  session root from the same `ProviderHost` as the extracted adapter, retaining the
  independent declared file/UUID and native header checks.
- Codex guidance remains exactly 7,115 UTF-8 bytes. Moving one heading between its existing
  context entries produces 3,143/3,972-byte entries below the native entry limit, without
  changing any combined guidance bytes.

## Protected boundaries and limits

### Preservation repairs after independent review

Comparison with owned main `b631232d51fa6705a72e3f0021cee139999c6b69` found
regressions beyond the initial provider-row visibility repair. The candidate preserves
the following existing decisions through their live consumers:

- Scient's canonical provider presentation order applies to Settings and Add Provider,
  independently of package registration order. Scient stays first; custom accounts remain
  grouped beneath their driver. Rendering unconfigured built-ins creates no settings entries.
- Shared enablement and actual driver schemas agree for every registered built-in. Scient
  and Antigravity retain their existing on defaults; Droid and OMP retain their off defaults.
  Explicit disables win, and ACP Registry still has no implicit default instance. Scient's
  defaults have one owner reused by schemas and eligibility rather than a second drifting list.
- Reviewed ACP removal keeps the existing settings-lock owner. Bare catalog removals retain
  atomic reference checks; reviewed removal still rejects shared installations and changed
  receipts. A real settings/catalog integration test also proves subsequent writes complete.
- Scalar, null and array legacy provider blobs keep their original settings file for repair.
  Readable siblings and named instances remain readable; migration does not discard the
  unreadable bytes during its automatic rewrite.
- A rejected or failed CLI replacement preserves the prior app-owned launcher. Human browser
  download copies claim names exclusively, so simultaneous copies and external writers cannot
  overwrite an existing destination. Agent download attribution remains unchanged.
- Codex onboarding setup respects `providers:manage`, including disabled controls, auto-start
  and callbacks after scope revocation. Terminal access does not imply provider-management
  permission, and backend authorization remains the final authority.
- ACP status and authentication guidance retain Scient's product name through the existing
  application composition. Standalone package defaults and transport identity remain upstream's.

These are preservation repairs, not new model, reasoning, enablement, provisioning or design
decisions. Synthetic fixtures exercise the failure conditions; they do not establish real-provider
or visual acceptance.

### Remaining platform and product limits

Scient labels, canonical provider tools, state roots, partition identity, migration order,
MCP/RPC authorization, attachment ownership, frozen inherited history, queue semantics,
passive provider probes and lifecycle provisioning remain protected. Provider-specific
protocol behavior stays in the provider boundary. Historical approvals remain history,
not executable authority. Analysis/Skills/OMP seam manifests track their new live owners.

Static import review found mobile consumers using client-safe provider exports, without
SDK/keyring execution reachable through those imports. Package manifests do retain server
SDK/native dependencies in installation closure; this is dependency weight, not proof of
mobile binary inclusion or network activity. Cursor SDK/keyring desktop packaging was
reviewed against the native payload contract.

Browser profile reporting is authorized by `preview:operate` and contains profile IDs,
names and kinds, not credentials. The server retains one latest in-memory report, so
another authorized client can replace the reported list/default. Per-client ownership
and the selection policy for agent `preview.open` remain a follow-up; this candidate
does not claim per-client profile isolation.

Native Windows execution, mobile device execution, real-provider sessions, microphone,
OAuth/deep-link ownership and the user's visual acceptance are not established by mocked,
markup, typecheck or static packaging tests. Candidate launch readiness is recorded
separately from feature acceptance. Publication remains held.

`pnpm lint:mobile` found 16 Swift and 27 Kotlin source files, but SwiftLint,
ktlint and detekt were unavailable and their checks were skipped. Generated native
folders were excluded. This is an explicit qualification gap, not a native lint pass.

## Separation measurement and maintainer review

The declared instruction extraction uses the same 21 non-test upstream host paths
at official `ec80933ac8cd02fec5c97b342462ccc9567cdb1e`, extraction base
`eaa42295c2271f7b92acd7857615391dd54e783c`, and measured candidate
`3afc49ea82d35be81055f9efa26cb3905e49bfbf`:

| Measurement                                       |  Base | Candidate |
| ------------------------------------------------- | ----: | --------: |
| Added non-test lines in those official host paths | 4,029 |     4,296 |
| Changed host files                                |    18 |        21 |
| Scoped unmarked inventory findings                |   612 |       604 |
| Scoped marked findings                            |    14 |        46 |

The policy bodies move to Scient-owned modules, and generic prompts regain exact
upstream defaults. Typed optional callbacks, imports and paired markers add physical
host lines. Independent review found these seams appropriate and no simpler safe
composition that preserves both products' defaults. Muse's driver keeps the original
layout rather than adding indentation churn. An unconsumed Codex device-policy copy
and empty retired-policy markers were removed. The host metric still rises by 267 lines.

**Maintainer-approved bounded exception — 2026-10-10:** the user accepted retaining
this reviewed neutral callback composition and requested comments identifying the
Scient host seams before a history-preserving merge. This accepts the measured
267-line increase for this fixed interval in exchange for removing mutable Scient
instruction bodies from generic provider hosts. It does not authorize a general
line-budget exception, product-policy changes or a waiver of runtime fidelity,
future measurements and nonincreasing scoped debt. Paired markers added at delivery
are annotation-only and measured separately below. The earlier unapproved proposition
and qualified-cursor hold are superseded by this specific acceptance; the current
pointer advances only after final delivery qualification.

The global advisory report at the measured candidate contains 11,941 unmarked findings
and 111 unresolved unsupported-language findings; it has no parser/object errors. These are not a
passing ratchet, behavior proof or a claim that all repository debt was removed.
Only the declared extraction scope is used for the nonincrease comparison.

The fixed comparison paths are:

- `apps/server/scripts/record-grok-acp-replay-fixture.ts`
- `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`
- `apps/server/src/provider/CodexDeveloperInstructions.ts`
- `apps/server/src/provider/builtInDrivers.ts`
- `packages/provider-acp/src/server/adapter.ts`
- `packages/provider-core/src/server/orchestrationInstructions.ts`
- `packages/provider-core/src/server/runtimeInstructions.ts`
- `packages/provider-cursor/src/server/adapter.ts`
- `packages/provider-cursor/src/server/driver.ts`
- `packages/provider-muse/src/server.ts`
- `packages/provider-muse/src/server/adapter.ts`
- `packages/provider-muse/src/server/driver.ts`
- `packages/provider-opencode/src/server/adapter.ts`
- `packages/provider-opencode/src/server/driver.ts`
- `packages/provider-opencode/src/server/v2/adapter.ts`
- `packages/provider-pi/src/server/adapter.ts`
- `packages/provider-pi/src/server/driver.ts`
- `packages/provider-pi/src/server/mcpExtensionSource.ts`
- `packages/provider-pi/src/server/mcpInjection.ts`

## Verification before preservation repairs

Source qualification runs at `a218a45f80d19ce15a9a75a5a796e74a303f0646`, tree
`80794ecaa4217e259d773abe04d6177e15dbfba8`. The subsequent `3afc49ea82` delta
removes only empty comment markers and a blank line; no instruction, executable
or signature bytes change. Commit `d739d1f3c859fd6737116f4bdc334f331d6d4dae`
changes only four test files. The remaining wide-run evidence is reused because
none of their production inputs changed. Maintainer documentation does not
alter runtime inputs. Final static checks and build cover the delivery tree.

| Check                                                                                                                                                                                                 | Evidence                                                                                                        | Result                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec vp fmt --check`                                                                                                                                                                            | source `d739d1f3c8` plus this maintainer receipt; 8,220 files                                                   | Pass                                                                                                                           |
| `pnpm exec vp lint --report-unused-disable-directives`                                                                                                                                                | final source `3afc49ea82`                                                                                       | Pass; existing warnings retained                                                                                               |
| `pnpm run typecheck`                                                                                                                                                                                  | 41 workspace tasks at `3afc49ea82`, affected server repeated at `d739d1f3c8`                                    | Pass; zero TS errors, Effect suggestions retained                                                                              |
| `pnpm run knip:check`                                                                                                                                                                                 | source `d739d1f3c8`; unchanged configuration                                                                    | Pass                                                                                                                           |
| `pnpm exec vp run -r --concurrency-limit 1 test`                                                                                                                                                      | runtime source `a218a45f80`; complete sequential workspace matrix                                               | 40 tasks; 39 passed. Server: 11,982 passed, six failed in three files; all six subsequently passed in the affected rerun below |
| `pnpm run build`                                                                                                                                                                                      | `d739d1f3c8`; six build tasks                                                                                   | Pass; known bundle/React Compiler warnings retained                                                                            |
| `pnpm run test:desktop-smoke`                                                                                                                                                                         | `d739d1f3c8`; fresh temporary state, scrubbed inherited role/home variables, `SCIENT_NEXT_SAFETY_ENVELOPE=true` | Pass; eight-second survival and graceful exit, not readiness or visual proof                                                   |
| `pnpm brand:check`                                                                                                                                                                                    | source `d739d1f3c8` plus this maintainer receipt                                                                | Pass                                                                                                                           |
| `node scripts/scient-seam-check.mjs -- --base 0cf6e0bd85c3d6be221b70164d2601e0b8e83e15 --upstream-ref ec80933ac8cd02fec5c97b342462ccc9567cdb1e --head a218a45f80d19ce15a9a75a5a796e74a303f0646`       | all five seams                                                                                                  | Pass; locator/classification evidence only                                                                                     |
| `node scripts/verify-upstream-provenance.mjs --base b631232d51fa6705a72e3f0021cee139999c6b69 --head 3afc49ea82d35be81055f9efa26cb3905e49bfbf --official-ref ec80933ac8cd02fec5c97b342462ccc9567cdb1e` | literal history and retained qualified cursor                                                                   | Pass                                                                                                                           |
| `git diff --check`, unmerged-index and anchored source-marker audit                                                                                                                                   | original owned base to final source                                                                             | Pass; no unmerged paths or source conflict markers                                                                             |

These are local checks, not hosted CI or user feature acceptance. Raw logs stay outside
source. No retry converts a failing wide run into a successful one; the final result and
any affected-scope reuse are recorded explicitly.

Final affected requalification at `d739d1f3c8`: six files, **113/113 tests passed**
in 35.10 seconds. It covers `OrchestratorMcpToolkit.integration`,
`ProviderSessionManager`, its Scient companion, `CodexAdapterV2.Media`,
`ClaudeCapabilitiesProbe` and `ScientV2SkillTurn`. The initial matrix counted
36,011 passing tests and 232 skipped; its six failures are retained as failures,
not relabeled. Together with the test-only affected rerun, every failure is
resolved while unchanged wide-run evidence remains applicable.

- The MCP fixture explicitly expects the supported transport's complete-empty
  catalog marker. No live outbound payload is used as its expectation source.
- Media assertions preserve complete guidance equality, capability withholding,
  mode separation and native compaction restoration, and now check each entry's
  4,000-byte bound instead of an incidental heading split.
- Interrupted-open coverage now asserts immediate credential revocation and
  that both interruption and same-ID retry remain pending after 30 seconds.
  Only actual physical close permits replacement. A separate second close
  permit proves that public shutdown is still bounded while close is pending.
  This preserves Scient's established stronger owner contract rather than
  upstream's assumption that a timeout may allow overlapping processes.
- The inline synthetic Claude probe clears its timer on input close, matching
  the existing reusable fixture. Production probe cleanup is unchanged. The
  previous owned synthetic child is confirmed gone; no unrelated process was
  signaled.

Focused causal qualification:

- Native repairs: 18/19 files passed (125 passing tests); the remaining Codex
  guidance budget failure was repaired without changing its native limit, then
  all three guidance files and 20 tests passed.
- Pi replay binding: 63 tests passed. All eight actual Pi orchestration replay
  scenarios subsequently passed against the corrected synthetic ProviderHost root.
- Earlier failing/aborted wide runs are diagnostic evidence, not final qualification.
  The complete matrix runs sequentially after the candidate stabilizes.
- Independent final provider review reports no blocking finding in the Codex
  partition, Pi canonical-name/native ESM composition, historical recording
  reconstruction or replay root repair. This source review ran no tests.

Independent final source review also accepts the four test corrections in
`d739d1f3c8`: no production source changes, no weakening of the complete guidance,
capability, native replay or session-ownership guarantees. The reviewer ran no
tests; executable evidence belongs to the qualification above.

## Provider catalogue visibility correction

The user's review found that adopting upstream's configured/enabled row filter
hid Scient's disabled, unconfigured built-in providers. Settings now enumerates
all supported built-in default slots from the existing client registry, including
Cursor before its first snapshot. Synthetic rows preserve the same `{ driver }`
configuration and existing enablement policy; enumeration does not persist,
install, authenticate or enable an instance. Drivers without a default slot, such
as ACP Registry, remain absent until configured. Custom instances, Add provider,
environment routing and management scope checks are unchanged.

Affected qualification against `532b0883bd` plus this correction:

- From `apps/web`, `pnpm exec vp test run --project unit
src/components/settings/ProviderSettingsPanel.environment.test.tsx
src/components/settings/ProviderSettingsPanel.logic.test.ts
src/components/settings/ProviderInstanceCard.test.ts
src/components/settings/ProviderInstanceCard.tabs.test.tsx
src/components/settings/providerDriverMeta.test.ts
src/components/settings/AddProviderInstanceDialog.environment.test.tsx
src/components/settings/AddProviderInstanceDialog.test.ts
src/components/settings/SettingsPanels.logic.test.ts --reporter verbose`:
  eight files, 124 tests passed. Fresh-settings coverage includes loading, empty
  and partial snapshots, disabled defaults, no writes and no fabricated ACP slot.
- `pnpm exec vp run --filter @t3tools/web typecheck`: passed; existing Effect
  suggestions retained.
- Targeted formatting, lint and whitespace checks passed; pre-existing lint
  warnings retained. No dependencies, runtime packages or server code changed.
- Independent read-only source review found no blocking issue in visibility,
  enablement, custom/ACP instances or environment ownership; it ran no tests.

This correction removes visibility conditions from the existing shared Settings
flow. It does not add a parallel provider catalog or change the separate pending
instruction-extraction proposition. Renderer HMR supplies the candidate change;
user visual acceptance and hosted qualification of the subsequent push remain
separate from these local checks.

The final handoff identifies candidate state/process ownership and readiness.
Visual acceptance, hosted CI and the structural proposition remain separate.

## Preservation repair qualification

Repair source `89974f96b6d7741c79cb2b23751f986db6143fbc`, tree
`3a11c96b8781d8e382cd706f248a85b6d5f08e0a`, was qualified anew after the
production repairs above. Owned main was fetched again at completion and remains
`b631232d51fa6705a72e3f0021cee139999c6b69`, already in the candidate's ancestry.
The following documentation-only delivery changes no runtime or test inputs.

| Check                                                                                                                                       | Result                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vp run -r --concurrency-limit 1 test`                                                                                            | All 40 tasks passed; 36,082 tests passed, zero failed, 232 skipped. Server: 923 files passed / 54 skipped; 12,013 tests passed / 180 skipped. Web: 950 files and 11,716 tests passed. |
| `pnpm exec vp run -r --concurrency-limit 2 typecheck`                                                                                       | All 41 tasks passed; zero TS errors, existing Effect suggestions retained.                                                                                                            |
| `pnpm exec vp fmt --check`                                                                                                                  | Passed.                                                                                                                                                                               |
| `pnpm exec vp lint --report-unused-disable-directives`                                                                                      | Passed; existing warnings retained.                                                                                                                                                   |
| `pnpm run knip:check`                                                                                                                       | Passed; no dependency/export suppression added.                                                                                                                                       |
| `pnpm run build`                                                                                                                            | All six tasks passed; existing bundle/React Compiler warnings retained.                                                                                                               |
| `pnpm run test:desktop-smoke` through the scrubbed candidate command wrapper                                                                | Passed in temporary state with `SCIENT_NEXT_SAFETY_ENVELOPE=true`. Survival and graceful exit, not visual proof.                                                                      |
| `pnpm brand:check`                                                                                                                          | Passed.                                                                                                                                                                               |
| Provenance with `--base b631232d51fa6705a72e3f0021cee139999c6b69 --head 89974f96b6 --official-ref ec80933ac8cd02fec5c97b342462ccc9567cdb1e` | Passed; literal history retained and qualified cursor held.                                                                                                                           |
| Seam check with `--base 0cf6e0bd85c3d6be221b70164d2601e0b8e83e15 --upstream-ref ec80933ac8cd02fec5c97b342462ccc9567cdb1e --head 89974f96b6` | All five seams passed. Classification/locator proof only.                                                                                                                             |
| `git diff --check` and unmerged index                                                                                                       | Passed; no unmerged paths.                                                                                                                                                            |

The targeted causal checks also passed: contract/shared defaults (262 tests), real
driver schemas and fallback defaults (17), desktop owner/copy paths (126), final
backend settings/catalog/defaults composition (121), and client scope/order flows
(48). These overlapping counts are not added to the full-matrix total. ACP package
catalog and product-copy checks passed separately. The initial six malformed-file
failures and the real-lock removal timeout were reproduced before their repairs;
they remain negative evidence, not qualification failures relabeled as passes.

Independent final reviews found no further blocking regression in the inspected
provider/model, client, desktop, fork, queue and session-owner paths. Approved
medium reasoning for Codex/Claude and high for Antigravity remain intentional;
Main's older forced-high mapping is not restored over that prior user decision.
Explicit selections remain authoritative. No new product decision is claimed.

The fixed 21-path extraction scope is byte-unchanged from measured `3afc49ea82` to
this repair source, so its measured 267-line increase and the separate maintainer
approval hold still apply. At source `89974f96b6`, a hosted snapshot showed 36
successful checks, including server/web shards, with only the known provenance
job's subsequent seam step failing against the held older cursor. The provenance
step itself passed. The documentation push receives its own hosted qualification;
this record neither reports all CI green nor bypasses the hold.

The isolated candidate was deliberately refreshed after backend/desktop repairs.
Its previous service, recorded PIDs and ports stopped before replacement. The new
service is `com.scientfactory.scient-dev-app.candidate.539e14a83b8d13c9`, runner
71679, Electron 73754, backend 74239, web listener 71807 at the readiness snapshot.
Bundle identity remains
`com.scientfactory.scient.next.dev.scientt3sync101f8b2f5520261009`, display name
`Scient (Dev) · scient-t3-sync-101f8b2f55`, state below this worktree's `.scient-next`.
Backend 14049 and web 6009 are owned by those processes and respond with HTTP 200;
new-start traces record `backend ready` and `main window created`. A separate
status recheck remains running, and the existing candidate `statev2.sqlite`
remains present. No profile was copied or reset; stable and other candidates were
untouched. The app stays running for the user's visual review.

These are synthetic/local and hosted source checks, not proof of every possible
regression, real-provider/OAuth/microphone acceptance or native Windows/mobile
execution. CLI failure preservation does not add a cross-process ownership
transaction around pre-existing ownership checks. Browser profile ownership's
existing shared-report limitation remains documented above. No visual interaction,
merge, queue, auto-merge, release or cursor advance was performed in this pass.

## Additional Main-preservation review

The subsequent review compared the active provider, onboarding, chat, sidebar,
mobile and desktop consumers with refreshed owned main
`b631232d51fa6705a72e3f0021cee139999c6b69`. It found four further preservation
issues and repaired them in source `511bc318c4aca9123e0f966693629264c93e6a17`,
tree `2def71f23ac44f85529594314d1196b64488b10b`:

- Remove the new left-column warning/error headline from the shared provider
  card. Main's compact vendor/version row, update icon, update progress/failure
  copy and right-pane diagnostics retain their existing behavior. Pi's existing
  suppression of routine inventory copy is preserved, rather than inventing a
  new warning-display policy.
- Replace OpenCode's live “T3 Code” Server URL help with neutral schema copy.
  The generic form still reads the provider package annotation; no duplicate
  form, schema decoder or product-name abstraction is introduced.
- Preserve Scient's 20px desktop chat lane instead of absorbing upstream
  #17372's unconditional 48px margins. CSS, measured probe and pure geometry
  agree. The 800px comfortable lane remains 736px; the details card remains
  available throughout 984–1011px. Existing marker hitboxes still cap themselves
  to the measured gutter, and mobile padding and preview clearance are retained.
  Greater marker availability at the expense of chat width is a separate
  product tradeoff, not an implicit alignment decision.
- Make the new shared desktop contents-command API delegate Reload/Force
  Reload to Scient's existing renderer save barrier. Upstream menu routing
  remains intact, and all API callers use the same guarded path. Non-revealing
  dispatch targets the registered main window even when an OAuth popup has
  focus. DevTools still targets main directly. The preexisting unload guard was
  not removed by the regression; the defect was bypassed flush/continuation and
  blocked-reload feedback, not demonstrated unconditional file loss.

Independent source review found no further blocking preservation issue in those
inspected consumers, and reviewed the repairs separately from their author.
Scient-first order, subscription/vendor labels, shared lifecycle controls,
scrollable onboarding, pinned project actions, sidebar design, explicit models
and saved provider options remain preserved. Saved reasoning selections stay
pinned; an existing conversation with no saved reasoning selection follows the
approved provider default dynamically, as Main's selection mechanism already
did. This does not rewrite its saved history or options.

On macOS with Node 24.19.0 and pnpm 11.10.0, the following requalification passed:

| Check                                                         | Result                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Provider card/form/catalog/tab tests                          | 47 passed; left-copy and branding assertions first reproduced their defects.                        |
| Chat geometry/details-card tests                              | 35 passed, including the 800px lane and each 984–1011px card boundary.                              |
| Desktop menu/window/IPC and renderer save-guard tests         | 65 passed; popup targeting, no immediate native reload, save completion and blocked reload covered. |
| Affected web, desktop and OpenCode typechecks                 | All three tasks passed; desktop was checked again after its error-channel refinement.               |
| Whole-repository formatting and lint                          | Passed; existing warnings retained.                                                                 |
| Branding, literal provenance and all five frozen-target seams | Passed; the qualified cursor remains held.                                                          |
| Full build and desktop smoke                                  | All six build tasks passed; smoke passed in temporary state under the safety envelope.              |
| Whitespace, index and main ancestry                           | Clean; no unresolved paths; refreshed main remains an ancestor.                                     |

The 147 targeted tests are overlapping requalification, not additions to the
earlier 36,082-test matrix. That full matrix remains evidence for unchanged
runtime paths; it was not rerun or presented as a new full-suite result here.
The fixed 21-path extraction measurement and its separate maintainer approval
hold are unchanged. No CI suppression, cursor advance or policy waiver was added.

The same isolated candidate was refreshed for its bundled desktop/package
changes. Its old service/processes/listeners stopped before relaunch. The
readiness snapshot records runner 25193, Electron 53468, backend 53933 and web
25276, with the same candidate service/bundle identity and retained state. Ports
14049/6009 have those owners and return HTTP 200; new-start traces at
2026-10-09T23:23:52Z record backend readiness and main-window creation. No live
profile was copied or reset and no other candidate or stable launcher changed.
Startup/smoke and source review do not establish visual or real-provider
acceptance. The candidate stays available for the user, and this PR remains held
without merge, queue or auto-merge.

## Accepted composition and delivery qualification — 2026-10-10

The maintainer accepted the fixed-scope callback tradeoff and authorized a
history-preserving merge after identifying the Scient host lines with comments.
This supersedes the earlier structural hold; it does not grant release,
publication, provider activation or a general host-line exception.

Comment commit `29162e8fb9` adds narrow paired regions around Scient imports,
typed callback seams and application instruction mounts in 12 TypeScript files.
AST printing with comments removed is byte-identical to the preceding source for
all 12 files, including Pi's generated extension source and literal prompt bytes.
The final fixed-scope host metric at `873892c106e83f2a58ef502fa83aaaa2068fa1b1`
is **4,339** lines: the reviewed 4,296 plus **43 net annotation-only lines**
requested by the maintainer. The original composition exception remains +267;
annotation-only accounting is recorded separately rather than represented as
additional runtime plumbing. Generic upstream defaults remain unmarked.
The independent exact-snapshot inventory for the same 21 paths reports **589
unmarked findings, 64 marked findings and zero unresolved findings**, compared
with extraction base 612/14/0 and pre-annotation candidate 604/46/0. This remains
structural evidence, not a behavior test or globally activated debt ratchet.

Owned main advanced with the remote-server packaging contract. Catch-up merge
`873892c106e83f2a58ef502fa83aaaa2068fa1b1` has exact second parent
`c414ac935b49fccb026b5a6e01f4714246375d73`; it merged without textual conflicts.
The package builder, native qualification script, dependency owner and new
qualification workflow match that main revision exactly. They add no publication
permission, credential copying or automatic installation to the product.
Focused release/package tests passed **43/43**, Windows/remote CI gate tests
passed **5/5**, and scripts typecheck passed. Native Linux/Windows tarball
execution remains hosted qualification, not a local macOS claim.

Whole-repository formatting and lint passed with existing warnings. Literal
provenance and all five default seam checks passed with the qualified cursor at
`ec80933ac8cd02fec5c97b342462ccc9567cdb1e`. Runtime qualification remains the
complete 36,082-test matrix plus the documented affected requalification at
`511bc318c4`; comment-only source equivalence justifies reusing those unaffected
results. This is not a new full-matrix run or a visual/live-provider acceptance
claim. The current pointer and state advance to the exact official extension
merge `eaa42295c2271f7b92acd7857615391dd54e783c`, retaining all historical
bootstrap and exception records. Protected hosted checks still qualify the final
pushed revision before GitHub's ordinary history-preserving merge queue delivers it.

## Extension to bd2346eda2 — 2026-10-10

This extends the same branch, worktree and Scient PR #498. The preceding
43-commit receipts remain historical evidence; they do not qualify the new
117-commit range. The original owned base remains
`0cf6e0bd85c3d6be221b70164d2601e0b8e83e15`.

| Input                               | Exact revision                                  |
| ----------------------------------- | ----------------------------------------------- |
| Previous qualified candidate        | `96b6560e09efa74224193dae545523e9344b1e81`      |
| Previous official boundary          | `ec80933ac8cd02fec5c97b342462ccc9567cdb1e`      |
| Frozen official target              | `bd2346eda2e2c380d1844869c7fd16c279d2190f`      |
| Literal official extension merge    | `de4f75bb7267e9bb0cbfcc5cc8ce8b2c8675222c`      |
| Frozen owned main                   | `bb0dcff656c7dba467fa32d662a8f221025a76ff`      |
| Owned-main composition merge        | `f0a053954fc1524286a1044a4cdb34892b4db9ee`      |
| Pre-late-main checked source commit | `e55ed9fca43bbcd68a1e750a76dc18b76a5c2e07`      |
| Pre-late-main checked source tree   | `5563028771fa67c1dab40bd427f3e679fd17caa4`      |
| Target description                  | `v0.0.46-nightly.20261009.2861-123-gbd2346eda2` |

The official merge has exact parents `96b6560e09efa74224193dae545523e9344b1e81`
and `bd2346eda2e2c380d1844869c7fd16c279d2190f`. The owned-main merge has exact
parents `de4f75bb7267e9bb0cbfcc5cc8ce8b2c8675222c` and
`bb0dcff656c7dba467fa32d662a8f221025a76ff`. Both frozen targets are ancestors
of the final source commit. The full official range from
`2a93885bac5798a79d55069a0b5dc3e53c6176bc` contains **160 first-parent commits**:
the original 43 plus this extension's 117. Later official commits are outside
this frozen receipt. The upstream push URL remains disabled.

### Canonical cutover and owned composition

- Adopt the upstream Effect 4.0.2 service contracts, `ModelCatalog`,
  `ProviderLatestVersions`, scoped `McpProviderSessions`, driver-owned usage
  readers and host-process references. Scient provider instruction, tool,
  fork, queue and lifecycle authority remains at its existing application
  boundaries rather than a parallel legacy provider API.
- Adopt all extracted source-control packages, including GitCafe, provider
  resolvers, per-item edit/resolve permissions, Azure token addressing and the
  usage/account fixes. Managed Droid publication checks include the actual
  provider-testing and source-control import closure; this does not publish
  or activate a managed artifact.
- Register Scient MCP tools using upstream toolkit schemas and the canonical
  `Tool.Handler` service shape. Retain exact parameter/success/failure types;
  no `Tool.Any` widening or cross-API `Effect`/`Layer` casts are used to hide
  service requirements. Static registration contexts exclude request,
  client, HTTP, log-level and invocation carriers. Each execution gets the
  live MCP invocation; the original Scient guard supplies agent authority
  only after catalogue, thread, capability and workspace admission.
- Keep upstream scoped-session ownership in runtime and replay fixtures.
  The retained-close fixture provides MCP sessions and Node services through
  one combined layer, avoiding an actual service-lifetime warning rather than
  suppressing the native compiler's diagnostic.
- Compose real worktree-retention admission and cleanup. An admitted
  operation, not a void acquisition result, controls deletion. Empty-directory
  removal uses the existing Node filesystem owner and nonrecursive `rmdir`;
  nonempty recovery directories and file remnants are preserved.
- Preserve scientific source save/close ownership, rooted workspace assets,
  scientific preview behavior, safe Markdown/BiDi rendering, the owned chat
  lane, fork/queue/Resume ownership and existing privacy/publication guards.
  Adopt upstream resize subscriptions and layout commits without substituting
  no-op observers; test observers deliver actual target entries and unobserve
  correctly.
- Preserve Scient-first provider-family presentation. The upstream active
  instance priority is retained in the composer: a selected Codex instance can
  appear before the other families without changing provider defaults.
- Keep canonical OpenCode connection/reconnection and partial-usage behavior
  in the migrated fixtures. Windows archive fixtures contain real PE/ELF
  native bytes and prove packed/unpacked/extracted availability; incidental
  destination-copy assertions are not a native-payload guarantee.
- Remove obsolete wiring/default/wording-copy assertions instead of repinning
  them. Retain consumer-visible authorization, privacy, precedence,
  lifecycle, usage and archive checks.
- Preserve Scient product notices and storage-home copy. The latter was
  found in the actual isolated native Storage page, corrected in the source,
  rebuilt and observed as “Scient home folder.”
- Review the changed skills, analysis, LaTeX and OMP seam classifications
  alongside the new service ownership. The retired Cursor test harness now
  uses `TestProviderHost.layer` and has no LaTeX state mount; remove that
  obsolete manifest entry rather than point it at an unrelated locator.
  Actual shared replay/Codex LaTeX mounts remain. All five changed-path seam
  checks pass; locator classification is not behavior or ancestry proof.

### Isolated native interaction evidence

The worktree-owned development launcher ran the compiled candidate as
**Scient (Dev)** at `scient-next-dev://app/`, using its private
`.scient-next/scient-next-dev` profile and cache. The app was attached through
its native CDP endpoint; Scient's ordinary web-preview tab could not attach
to this Electron target. No live profile was copied or reset.

- Observed Scient onboarding and skipped opt-in setup. Admitted a temporary
  local folder through the actual project picker with **Open without setup**;
  no project scaffold or provider run was created.
- Opened a temporary HTML file through Files into the integrated browser's
  signed `workspace-file` asset URL rooted at that folder.
- Opened a Markdown file in the actual source workspace, typed
  `Alignment source-save persisted final state.`, immediately closed it,
  and observed that exact value on disk. Reloaded the native app, reopened
  the file through Files and observed the identical editor value. This is
  actual save/close/reload behavior, not a callback-forwarding test.
- Typed and cleared an unsent mixed Arabic/Latin draft; collapsed and restored
  the sidebar. The voice-message launcher remained available. No prompt was
  dispatched and no microphone/audio session was started; this is not a live
  conversation or speech-transcription acceptance claim.
- Read the provider inventory: Scient appears first in family settings,
  followed by Codex, Claude, Antigravity, OpenCode, Droid, Pi, Oh My Pi,
  Cursor, Grok and Muse Code. Scient remained uninstalled; no provider setup,
  credential connection, Cursor usage hub or billing source was activated.
- Read Storage with inactive retention/artifact/log cleanup and a disabled
  Delete-now action. After the final build and native reload, observed the
  corrected Scient-home text and the same inactive cleanup hold.
- Removed both temporary project admissions through the real scoped
  project-removal UI, which explicitly preserves files on disk and clears
  their drafts. Both persisted project rows are tombstoned; the native home
  screen reports **No projects yet**. Removed the temporary Markdown/HTML
  files, their empty fixture directories and the compiler diagnostic probe.

These observations do not qualify native Windows/Linux execution, macOS
passkeys/default-browser registration, mobile device gestures, live provider
turns, audio capture or signed publication. Those platform/live acceptance
boundaries remain explicit; no defaults, credentials, release authority,
merge queue or auto-merge are activated by this receipt.

### Literal extension inventory

- `2cf0ff0643` — fix(web): Local environment switch stays reachable after turning it off (#17359)
- `c5d4d2d04c` — fix(web): keep chat banners inside the lane beside the docked details card (#17094)
- `a947f7c099` — fix(web): settled and snoozed lines line up with the messages above them (#17191)
- `22ccf8a3df` — fix(web): distinguish project filter from new project (#12113)
- `b1508672a6` — feat(web): assign a thread details panel shortcut (#16694)
- `a6698271a4` — fix(web): chat content keeps pace with sidebar resizing (#17383)
- `2c1915b319` — refactor(provider-core): expose model metadata through a ModelCatalog port (#17417)
- `b66dd402e8` — refactor(provider-core): follow the Effect service conventions throughout (#17427)
- `68ab16f308` — refactor(provider-core): latest-version lookups go through a ProviderLatestVersions service (#17434)
- `784b5625f9` — refactor(provider-core): MCP provider sessions live in a McpProviderSessions service (#17446)
- `31b04e2ee9` — refactor(provider): bring opencode, muse, pi, core and testing in line with Effect conventions (#17542)
- `f853d514ca` — refactor(provider-acp): ACP, ACP Registry and Grok follow the Effect service conventions (#17544)
- `33806e7355` — refactor(provider-cursor): follow the Effect service conventions (#17545)
- `64972461c0` — fix(marketing): use app wordmark in header (#13240)
- `aa8c6662e2` — fix(web): pr merge actions stay visible while the stack refreshes (#17559)
- `91a6646efd` — chore(deps): upgrade Effect to 4.0.2 (#17571)
- `ecfb7342ed` — fix(devices): recover stalled video without losing simulator input (#17566)
- `7856908b84` — fix(web): keep checkout stable while pr actions load (#16625)
- `1fd558d9e2` — fix(mobile): show waiting thread status (#16693)
- `5722496b79` — feat(web): add parent thread breadcrumb navigation (#16666)
- `0a4d789128` — fix(server): restart inactivity after snoozed threads wake (#16674)
- `454b94a13a` — feat(desktop): passkeys in the in-app browser on macOS (#16952)
- `a1db449fe4` — fix(client): load earlier turns works for MCP threads over T3 Connect (#17599)
- `0e7abea7c9` — refactor(client): sign relay request URLs built from the HttpApi contract (#17602)
- `28f11ed7a5` — refactor(source-control): add @t3tools/source-control-core (#17573)
- `f6e45028ef` — refactor(source-control): Forgejo lives in @t3tools/source-control-forgejo (#17581)
- `d01febb509` — refactor(source-control): Azure DevOps lives in @t3tools/source-control-azure-devops (#17592)
- `eb459b5afa` — refactor(source-control): GitLab lives in @t3tools/source-control-gitlab (#17594)
- `8d1858d9d6` — refactor(source-control): Bitbucket lives in @t3tools/source-control-bitbucket (#17597)
- `507361bc73` — refactor(source-control): GitHub lives in @t3tools/source-control-github (#17607)
- `e5dca2332f` — refactor(usage): transcript readers come from their drivers (#17576)
- `23957c704b` — refactor(usage): OpenCode usage comes from provider-opencode (#17577)
- `5a9c664b3e` — refactor(usage): Cursor account usage comes from provider-cursor (#17578)
- `9a0766b023` — refactor(usage): Antigravity usage is a reader on its driver (#17579)
- `b1ec4b3687` — refactor(usage): usage readers use Effect FileSystem and SqlClient (#17615)
- `6586a01f41` — fix(web): composer context strip pads both edges evenly (#17562)
- `a0a0e94822` — test(usage): v4 cache upgrade test waits for the migrated cache write (#17553)
- `c85dc64268` — feat(mobile): support Duo in the shared iOS app (#12648)
- `49f849ecce` — refactor(source-control): GitManager reads provider resolvers, not host kinds (#17617)
- `2ce3e4ae74` — refactor(source-control): PullRequestService reads GitHub resolvers, not its kind (#17619)
- `51347aca3a` — refactor(source-control): Forgejo identity and Azure DevOps addressing move into their packages (#17624)
- `58916b6554` — refactor: home directory comes from a HostProcessHomeDirectory reference (#17628)
- `e30852213e` — refactor(shared): host process references live in a HostProcess module (#17641)
- `6cd02e98f7` — feat(web): filter PR comments by bots and resolved threads (#17645)
- `0c4012055d` — fix(clients): remove redundant prefix from PR watch status (#17635)
- `99d2651dd5` — fix(web): pending requests wait until you stop typing (#17637)
- `08e18b7833` — fix(models): remove new badges from Claude Opus and Sonnet 5.5 (#17646)
- `5dcb59ed6c` — fix(ui): keep focus and selection borders visible across the app (#16675)
- `5fe9d024d9` — fix(mobile): prevent row presses during native back swipes (#17648)
- `140ee145ac` — fix(server): Codex shadow homes replace stray sqlite maintenance locks (#17663)
- `38571328a4` — feat(desktop): T3 Code can be your default web browser on macOS (#17587)
- `202b95403a` — test(server): the ACP process-tree test no longer collides with the runner's own pid (#17647)
- `cc62349c37` — fix(web): keep branch restore action inline in narrow composers (#14811)
- `3e94afa7c2` — fix(web): composer banner actions stay inline whenever they fit (#17640)
- `b744bded01` — feat(web): draft screen project picker is searchable (#17664)
- `b87b13d414` — fix(server): report incomplete transcript usage scans (#15661)
- `d97060709c` — fix(web): every resize-driven layout commits in the same frame (#17656)
- `ca40de081c` — fix(web): right panel and terminal drawer follow the pointer while dragging (#17657)
- `42e1a0fba2` — fix(web): terminal drawer keeps its height after the window shrinks (#17658)
- `033866c7aa` — perf(web): sidebar drags restyle only the sidebar (#17659)
- `eddc8fb817` — fix(web): server browser page resizes while the panel is dragged (#17660)
- `0caa95d6eb` — fix(storage): make worktree cleanup work and show why it skipped (#17563)
- `e858ddb656` — test(usage): usage service tests keep their state directory until cache writes land (#17636)
- `f3a69c70c6` — fix(checkpoint): pulls and rebases no longer flood a turn's changed files (#17161)
- `07b8080012` — fix(web): place notification icons after titles (#12209)
- `0b9623fda1` — fix(web): attachments on an open question are visible again (#15537)
- `f34adad34f` — fix(web): scale Files tree with interface font size (#8011)
- `318201caa5` — fix(server): probe only owned preview listeners (#16687)
- `ed4ea1083d` — fix(chat): surface pending subagent questions on parents (#16634)
- `c1f21e53b3` — fix(web): section header chevrons point up when collapsed (#14273)
- `e08c31e1a1` — fix(web): timeline divider pill shows a pointer, visible hover and focus ring (#15188)
- `6e4ca6ce9d` — fix(git): allow creating prs from dirty worktrees (#15625)
- `b822420e50` — docs(install): polish binary install destination phrasing (#15732)
- `0981e6b9d4` — perf(server): keep passive terminal output flowing (#17178)
- `b6aa268b12` — fix(web): stop button icon no longer shifts on hover (#16012)
- `9bbbbbab2a` — fix(web): add bottom padding to expanded tool panels (#16525)
- `2def3de4b9` — fix(web): keep incremental highlighter return type portable (#17259)
- `391f813357` — fix(web): sidebar "Code" label no longer clips its letter tops (#16134)
- `699da95689` — fix(tests): use POSIX paths for the simulated macOS device host (#17241)
- `88edfacf5d` — fix(mobile): Android composer keeps the caret in view on AOSP-based keyboards (#17492)
- `467fea963f` — test(web): allow cold timeline imports on CI (#16608)
- `aa165e9b9c` — fix(mobile): pinch zooms chat images on Android (#15047)
- `d1e56e79ff` — fix(web): selected provider ring no longer clipped during panel resize (#17534)
- `d50a2a6fc5` — docs(usage): OpenCode Go limits need a Go API key (#15664)
- `c116dacb83` — fix(web): improve usage scanning indicator alignment (#15498)
- `97009b049a` — fix(server): print pairing credential expiry as ISO timestamp (#14128)
- `2cc55f2f22` — chore(ci): use GPT 6.1 Sol Max for check agents (#14312)
- `8b81a8880f` — fix(mobile): honor requested terminal native architectures (#10709)
- `5c715c6941` — fix(server): keep preview browser connected after operation timeouts (#17693)
- `aacefcd7e9` — fix(web): timeline divider focus ring stays inside the pill (#17702)
- `03bd839554` — perf(desktop): reuse prepared shell environment in the local backend (#17384)
- `f02002ab95` — fix(web): align settings page widths (#12158)
- `a3d1505141` — test(server): resolve the temp dir before matching the symlinked entrypoint (#9400)
- `6e83160cdf` — fix(web): keep inline code pills intact when they wrap (#12038)
- `2aa033b11d` — Revert "chore(ci): use GPT 6.1 Sol Max for check agents" (#17698)
- `f55c66b323` — fix(web): show the correct new thread shortcut in command palette (#8513)
- `c1ade7db94` — fix(desktop): declare macOS local network usage (#11922)
- `968ac2e82b` — docs: add Scoop as Windows installation method (#10509)
- `a0a601c262` — fix(server): agents run in their own systemd scopes so an OOM kill spares the server (#17662)
- `4ea735614b` — fix(web): welcome wizard says where imported projects come from (#14584)
- `d02e292610` — fix(web): cite works on responses that end before a tool call (#17713)
- `fa9f936ef5` — fix(desktop): sign Windows native addons (#8206)
- `c572cb71d2` — fix(server): track resumed subagent follow-ups as separate tasks (#17696)
- `c2a301b12a` — fix(web): nested corners follow their container's radius (#17695)
- `1f093d119b` — feat(web): pr panel actions confirm in place (#17710)
- `4107930420` — feat(web): reorder right panel tabs by dragging (#17730)
- `c899a0c06a` — fix(azure-devops): list pull requests with token sign-in and check out into worktrees (#17725)
- `0be20c86c2` — fix(usage): keep one email in two workspaces as two accounts (#17711)
- `c3243f0508` — feat(pull-requests): hosts can report edit and resolve permissions per item (#17667)
- `9cc57680cb` — perf(server): run Git for Windows' real git.exe, not its launcher (#17707)
- `a7223f3969` — fix(clients): restart continuations show as a T3 Code notice, not another agent's message (#17723)
- `57b3780770` — fix(mobile): browser picture in picture opens from the header button (#17731)
- `65d33177b7` — feat(source-control): GitCafe lives in @t3tools/source-control-gitcafe (#17681)
- `500cb4266f` — fix(web): add provider wizard no longer shifts sideways while it grows (#17292)
- `42f71dfe07` — fix(web): PR search keeps the caret where you type (#17675)
- `6d5ea190a4` — fix(server): thread PR badges catch up when another environment reads the PR (#17729)
- `bd2346eda2` — fix(server): refuse editor paths with line breaks or quotes when the editor is a Windows command shim (#17749)

### Late owned-main catch-up

Owned main advanced during qualification to
`397befbdaab86d5798c840168a398d653e96f081`, containing landed Scient PRs
#505, #507 and #508. This is a second frozen owned-main boundary, not a change
to official target `bd2346eda2`. It adds stale-V1 snapshot reconciliation,
continued-V2 state preservation, recovered-history version reuse, batched
baseline reads and isolated Stable/Beta release channels.

The importer conflict composes the canonical Effect service imports with
the landed reconciliation owner. `reconciliationFailure` is required;
startup and its production fixture no longer use optional carrier fallbacks.
Review found an actual attachment-ownership composition defect: the older
retry repair could overwrite V2 attachment edits after guarded source
reconciliation. Retry repair now applies only to revision zero; recovered
source revisions retain the transaction's ownership decision. The existing
compacted/noncompacted recovery scenario now includes V2 message and user-item
attachment edits during interrupted recovery.

The selected V1 source is strictly the sibling `state.sqlite` of configured
`statev2.sqlite`; there is no fallback to another profile. A synthetic
development-profile regression covers ignoring an unrelated userdata source.
The native candidate's selected sibling V1 source is absent. No live legacy
profile was inspected or copied.

Stable/Beta code preserves main's explicit preference and isolated feed
contracts, empty-Beta handling, checksum/error boundaries and distinct
transition payloads. Nightly internals remain where the landed contract
requires them; legacy Nightly preferences migrate to Stable without Beta
enrollment. A non-Beta build still defaults to Stable. No channel choice,
download installation or publication is activated here. Affected new
workflow-string assertions were removed, retaining the actual Bash/JQ
publication rehearsal and consumer-visible channel/integrity tests.

The superseded full matrix was cancelled before completion, not counted as a
pass. Its retained output exposed the server fixture's missing canonical
terminal metadata subscriber, causing 241 startup failures. The fixture now
delivers its initial empty-terminal snapshot before returning an unsubscribe
function. Production cleanup subscription behavior is unchanged; the
fixture no longer bypasses or throws on that startup contract.

The settings fixture also supplies the canonical scoped `subscribeChanges`
effect for its unchanged settings model, matching the existing test-service
pattern. The complete router/recovery/config qualification now passes
**11 files / 382 tests**, including real HTTP/WebSocket ingress, startup,
attachment-preserving recovery, batched baseline reads and development-source
isolation.

Catch-up merge `71b1799a9db1feb1a8f102b5f528314e32230ca2` has exact parents
`32c01ab2ed9d97e62b54ee7a6a8390dca32a9232` and
`397befbdaab86d5798c840168a398d653e96f081`. Fixture-complete source commit
`b05b2050b37db544cbba686fbb33b5eb1e3921f5` has tree
`bbfff82654c5aa6726ad70be513773b0001294ed`. The latter adds only the settings
subscriber fixture; the product build and native observations are from the
same runtime source in the preceding merge.

Whole-repository formatting, lint, all 49 typecheck tasks, branding across
3,143 product-surface files, all five default seam checks and literal
merge-parent provenance pass for that fixture-complete source. Existing lint
warnings and native compiler suggestions remain visible; no enforcement rule
was disabled. Product build and Electron smoke pass after the latest-main
composition. Optional native-module/CJS build warnings remain unsuppressed.

`node apps/desktop/scripts/qualify-update-channels.cjs` passes **17 synthetic
cases** using the locked `electron-updater` 6.8.9 implementation. This includes
platform-specific feed/manifests, exclusion of unrelated prereleases,
non-downgrade decisions, matching Stable promotion, real loopback discovery
and downloads, distinct Beta/Stable bytes, verified cache reuse, checksum
corruption rejection and retry. It performs no native installation or
publication; simulated platform selection is not native Windows/Linux proof.

The rebuilt isolated native backend applied Scient migration
`24_legacy-source-reconciliation`. Its state directory and database resolve
to this worktree's nonsymlinked private profile; the selected sibling V1
source remains absent. The actual native General page displays **Stable**
as the update track, with Stable selected and Beta unselected in its menu.
The menu was closed without changing the value; update actions remain
disabled in the dev app. The clean native candidate remains open for
inspection, with browser automation released.

### Complete-matrix regression closure

The first completed post-catch-up matrix reported eight failures in three
server files; the other package groups passed. No failed run is counted as
qualification. The four startup-memory scenarios lacked the canonical
`McpProviderSessions` layer in their real Node fixture. Supplying that owner
preserves the existing garbage-collection checks across regular, handoff,
compaction and failure paths.

The Codex fixture now distinguishes a catalogue-listed current family from
an unknown discovered model. The current family loses its legacy flag, the
catalogue's retired family remains legacy, and the unknown family's existing
classification and every wire ID remain unchanged. Production classification
is not special-cased for the fixture.

The three queue timeouts came from delaying terminal reactions with a parent
command lock. Canonical child follow-up intake now serializes on that same
parent lock, making direct sends and new admissions block the fixture itself.
The fixture instead fences the committed terminal fact at the reactor's
filtered event tail, with an observed entry barrier and unconditional release.
It leaves projection reads, real user commands, native lifecycle frames,
checkpoint capture and durable command receipts intact. No timeout increased,
queue scenario removed, production lock order reversed or failure suppressed.
The focused native queue runtime passes **47 scenarios**; the memory/catalogue
checks pass **six scenarios**. The complete matrix is rerun after these fixes.

The next complete run at source `91540d3dcd2b6ad90da07e043903294c606d920c`
(tree `6fe812f176cb9b73bf216279259b5f0e1974b2c8`) passed every package group
except one router scenario. Its server result was 895 passed files, 54 skipped
files and one failed file: 11,278 passed tests, 180 skipped tests and one failure.
Project-clone setup received HTTP 426/plain text during session bootstrap.
The response matches a standalone WebSocket listener's default, not the
expected authentication API. Cross-fixture pooled-socket reuse is an
**inference**, not a demonstrated cause; this run is not a complete pass.

Router fixtures now request `Connection: close` on every real loopback HTTP
connection, including manual redirects, while retaining canonical fetch
compression, streaming and cancellation semantics. No retry or response
exception is introduced. Raw Node HTTP and cross-version Undici experiments
were rejected because they broke compression or dispatcher/Web API contracts;
all experimental adapters and dependencies were removed. Production transport
is unchanged.

Independent bounded source reviews by `ContractFixtureReview` and
`HttpFixtureReview` found no consumer-visible blocker in the final fixture
contracts and connection policy. These reviews did not run commands and do not
claim causal reproduction of the original 426.

Final fixture source `350ee4b6473c3ceee72688f01f89709abd8a13cd` has tree
`602f773266aedae02da4e6da3073d5874eb157f8`. Its router qualification passes
all **246 scenarios** and the server typecheck. Whole-repository formatting,
lint, all 49 typecheck tasks, branding, all five seam checks, literal merge
provenance and both whitespace checks pass for that source. The complete
repository matrix is executed again on this revision.

The exact path comparison from catch-up merge `71b1799a9d` to this source
contains only four server test/fixture paths. No runtime input changed:
`server.test.ts`, `NativeQueueHoldPolicy.integration.test.ts`,
`ProviderTurnStartMemory.fixture.mjs` and `codexModelCatalog.test.ts`.
The qualified product build, Electron smoke and isolated native observations
therefore remain evidence for the same runtime source, not for an older product
implementation.

A throwaway network smoke also observes two real accepted sockets closing after
their responses, with the canonical fetch layer and the default/manual-redirect
policies. Both requests carry `Connection: close`; their JSON bodies are intact.
The smoke file was removed after execution.

The first complete-matrix attempt at `350ee4b647` stopped on the web suite's
100 KiB table typing budget: observed p95 **126.330167 ms**, required below
**64 ms**. The web summary was 950 passed files and one failed file. Static
qualification ran concurrently with that matrix; resource contention is a
possible confound, not an established cause. No performance assertion, budget,
production editor code or scenario is changed. The failed command is retained
as failed evidence, not counted as qualification. The isolated strict lane and
the complete matrix with sequential package scheduling are qualified next.

The isolated `SCIENT_MARKDOWN_PERF_STRICT=1` lane passes all **five scenarios**,
including the tighter 16 ms table typing budget. Its source and assertions are
unchanged. The subsequent sequential package run stops in the web suite on
missing runner-generated temporary module files: 279 failed files, 672 passed
files, two failed tests and 8,228 passed tests. The missing paths are under the
runner's random temporary `ssr`/`client` directories, not project source files.
This command is also failed evidence; it does not qualify the unexecuted server
group.

Installed Vitest 5.0.1's fork worker sets `cacheFs=true` and transfers generated
module paths to workers; its thread worker supports inline transport instead.
The full web assertions are qualified with the supported thread pool and one
worker, without changing project files, skipping tests or relaxing budgets.
The full server group is qualified separately; successful unaffected package
groups from the sequential run are retained only as explicit aggregate evidence.
The agent does not claim to know what removed the temporary module files.

The complete web thread-pool run passes **951 files / 11,758 tests** at the same
source, including all Markdown performance scenarios. The sequential matrix
provides passing evidence for **45 unaffected package groups** before web;
server had not started when that command failed. The complete server group runs
separately and must pass before final aggregate qualification. Neither failed
root command is retroactively claimed as passing.

### Recovered final qualification — 2026-10-10

Continuation resumes from qualification source
`350ee4b6473c3ceee72688f01f89709abd8a13cd`
(tree `602f773266aedae02da4e6da3073d5874eb157f8`) and preserves both literal
merge boundaries. The bounded final follow-ups are qualified below. The remote PR previously remained at `96b6560e09e`; the recovered
continuation is published to that same PR only after qualification below.
Owned main refreshed to `397befbdaab86d5798c840168a398d653e96f081` remains
an ancestor. Later official-main advancements are outside this frozen pass.

The complete standard server command passes **896 files / 11,279 tests**,
with 54 files and 180 tests skipped. Its command is
`pnpm --dir apps/server exec vp test run --pool forks --maxWorkers 1 --reporter dot`.
A preceding thread-pool attempt was interrupted and is not a complete pass:
its CLI fixture requires `process.chdir`, unavailable in thread workers, and
it observed a provider-registry fixture directory-cleanup error. The focused
standard-pool pair passes 89 tests, and the directory-cleanup error does not
reproduce in the subsequent complete standard-pool run. No causal claim about
that cleanup error, skipped production scenario or relaxed assertion is made.
The invalid task invocation combining recursive selection and filters never
ran tests and is retained separately from successful qualification.

The remaining fresh lanes pass at source `350ee4b647`. Documentation edits
are present throughout; the scoped consumer/packaging lane and subsequent
server typecheck, Knip and build include the dependency cleanup described
below. The workspace task glob `*` selects
only unscoped names; its four passing groups are complemented by the scoped
`@t3tools/*` and `@scientfactory/*` lane, excluding the separately qualified
web and root. Together they cover all 45 other test-bearing workspace groups.
No successful partial lane is presented as complete workspace coverage.

| Fresh lane             | Result                                                  |
| ---------------------- | ------------------------------------------------------- |
| `other-packages-full`  | 53 passed files; 633 passed tests; 0 skipped tests      |
| `scoped-packages-full` | 985 passed files; 12,712 passed tests; 53 skipped tests |
| `web-full`             | 951 passed files; 11,758 passed tests; 0 skipped tests  |
| `web-layout`           | 41 passed files; 326 passed tests; 0 skipped tests      |

The web unit lane uses `--project unit --pool threads --maxWorkers 1` without
changing any assertions or performance budget. Other workspace tests retain
the default pool and use `--maxWorkers 1`; task scheduling uses
`--concurrency-limit 1 --no-cache`. Browser layout is the declared `test:layout`
project. All lanes run serially.

Fresh update-channel qualification, whole-repository format/lint, all 49
typecheck tasks, Knip, the product build, branding, all five seam checks,
literal merge-parent provenance and whitespace checks pass. Existing build
warnings and compiler suggestions remain visible. The build is not an app
launch. Aggregate test coverage does not turn either earlier failed root
command or the interrupted server attempt into a successful command.

An independent native Codex reviewer checked the 117-commit extension and
principal Effect, provider/MCP, request-authority, lifecycle, fork/queue,
import-recovery, scientific-document and publication seams at this immutable
source. No runtime blocker was found. Two stale release-policy explanations
were corrected in `UPSTREAM.md`: Stable/Beta ownership and the version-aware
owned release-repository resolver. These are maintainer documentation edits.

Fresh Knip initially reported the unused direct `diff@8.0.3` server dependency
left after upstream provider/source-control extraction. Removed that declaration
and only its three-line lockfile importer entry. All four actual consumers keep
their own dependency declarations and the resolved `diff` 8/9 entries; no server
source/script directly imports it. A frozen offline install passes without new
resolutions. Independent review confirms that `diff` is bundled through its
consuming packages, outside the server runtime-external allowlist: sidecar and
remote-server external roots remain unchanged. Fresh affected consumer/packaging
tests, server typecheck, Knip and the product build qualify this manifest-only
cleanup. Complete server/web results are reused for their unchanged runtime
code; the failed Knip attempt remains failed evidence. Prior native observations
predate the manifest cleanup and are supplemented by the new packaging/build
checks, not relabeled as a fresh native launch.

The subsequent Knip export audit found eight unconsumed exports. Five live
helper/tool-registration definitions become module-local with identical bodies
and local callers; two Pi helpers remain defined and internally consumed but
leave the unused server barrel, along with its unconsumed type reexport. The
unused default Cursor layer constructor is removed; the live Scient reader
still uses `make({ productName: "Scient" })` through its owned service layer.
No tool schema, handler, registration, preview result, adapter option or
provider operation is deleted. The cleanup changes six private implementation
modules and introduces no Knip exception. Focused MCP/usage and preview checks,
the complete affected Cursor/Pi/OpenCode package suites, all 49 typechecks,
lint, Knip and the product build qualify this follow-up. Full prior matrices
are reused for unaffected behavior; focused repeats are not added to their
aggregate counts. Independent review accepted all six paths, confirming the
remaining local consumers, unchanged provider factories and managed-runtime
paths, and no consumer requiring these private exports. Both failed Knip phases
remain failed evidence. The provenance wrapper invocation with a literal `--`
separator also failed; the direct Node invocation passes without a source edit.

The development candidate remains stopped at the user's explicit request.
Fresh Electron smoke and visual interaction are deferred because they launch
the app. The saved post-owned-main product build, Electron smoke and native
observations above qualify the baseline product implementation before the
bounded follow-ups: the path comparison from `71b1799a9d` to `350ee4b647`
contains only four server fixture/test paths. This continuation adds maintainer
documentation, alignment metadata and the unused dependency/export cleanup
qualified above with fresh affected checks and a build. Prior native observations
are historical evidence, not a fresh launch or renewed visual acceptance. Native Windows/Linux, mobile-device
interaction, live-provider/audio behavior and publication remain outside that
local proof. SwiftLint, ktlint and detekt are absent locally; the hosted mobile
static job installs its declared tools and must qualify the pushed revision.

The cursor advances to the literal frozen official target only after the
successful aggregate and static/build gates. This receipt qualifies local
source; hosted CI must separately qualify the final pushed head. No merge,
queue, updater activation, release, publication or app launch is authorized
by this record.

The initial hosted Documentation job at `afe6dc5cbd` found a stale link in
`adding-a-provider.md` after the canonical continuation-module rename. It is
corrected to `packages/provider-core/src/server/ProviderContinuationRequests.ts`.
The complete PR-changed Markdown set is checked for formatting and local links
after this documentation-only repair; prior runtime qualification is unchanged.
Hosted checks must still qualify the subsequent pushed head.

Hosted CI at `a39d3d474d` passed the other jobs, including mobile native static
analysis, Windows installation/runtime and transfer ceilings. Server shard 1
was cancelled at the unchanged 25-minute job limit while tests were still
passing. Its import-continuation suite alone passed 27 tests in 520.341 seconds
but had no recorded shard weight; the Droid adapter's 65.194 seconds were also
unrecorded. The 65-entry profile no longer represented the composed server suite.

Refresh the shard weights from that same CI run: completed shards 2/3 provide
634 file timings and shard 1's passing/skipped summaries provide another 206.
All 840 observations are disjoint members of the current 950-file suite.
Retain the five existing weights for current files without fresh observations;
remove obsolete paths and omit observed durations below the maintenance script's
0.5-second threshold. The refreshed profile contains 260 weights. Unobserved
files retain the sequencer's default cost. The existing deterministic greedy
assignment, all three server jobs, their 25-minute limits, individual test
limits, assertions and coverage remain unchanged. The existing sequencer tests
and current-file assignment check prove each of the 950 files is scheduled
exactly once. Timing estimates describe scheduling, not a completed CI pass;
the next pushed head still requires all hosted checks to finish successfully.
