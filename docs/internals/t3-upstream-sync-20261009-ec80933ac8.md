# T3 upstream alignment — 43 commits through ec80933ac8

This candidate preserves literal official history and current Scient product boundaries.
Source qualification, maintainer structural review, hosted CI and visual acceptance are separate.
This record does not authorize merging, release or publication.

## Immutable boundaries

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

Native Windows execution, mobile device execution, real-provider sessions, microphone,
OAuth/deep-link ownership and the user's visual acceptance are not established by mocked,
markup, typecheck or static packaging tests. Candidate launch readiness is recorded
separately from feature acceptance. Publication remains held.

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

**Codex proposition, not an approved exception:** retain this bounded neutral callback
composition and accept this interval's measured host-line increase in exchange for
removing mutable Scient instruction bodies from generic provider hosts. Scoped debt
must remain nonincreasing; this does not waive runtime fidelity, future measurement,
or authorize a general line-budget exception. No protocol amendment or approval is
claimed here. The separate aggregate-line reduction requirement is not met. Until the
maintainer accepts this specific tradeoff or a reviewed candidate meets the requirement,
`upstream-state.json` and the qualified cursor remain at `2a93885bac...`.

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

## Verification

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

The final handoff identifies candidate state/process ownership and readiness.
Visual acceptance, hosted CI and the structural proposition remain separate.
