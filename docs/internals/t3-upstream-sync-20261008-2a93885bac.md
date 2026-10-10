# T3 upstream alignment — 63 commits through 2a93885bac

Local runtime qualification is recorded below. The user approved visual review of the earlier candidate and explicitly authorized the owned-main catch-up and history-preserving delivery. Its later source and automated qualification are recorded separately; hosted checks still govern delivery. This record does not authorize a release.

## 1. Immutable integration inputs

| Field                                               | Value                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned base                                          | `565b3bd15cbb7660250e53b2421915d2f6bdebc5`                                                                                                                                                                                                                      |
| Previous official integration boundary / merge base | `b24f0fbba09d8623c896081b4ff70aa7190c8fda`                                                                                                                                                                                                                      |
| Official target                                     | `2a93885bac5798a79d55069a0b5dc3e53c6176bc`                                                                                                                                                                                                                      |
| Official reviewed range                             | `b24f0fbba09d8623c896081b4ff70aa7190c8fda..2a93885bac5798a79d55069a0b5dc3e53c6176bc` — **63 commits**                                                                                                                                                           |
| Target nearest tag                                  | `v0.0.46-nightly.20261005.2702`                                                                                                                                                                                                                                 |
| History-preserving upstream merge                   | `e0a46f2d5ace0b33fa4a8f714917f029f577db23`                                                                                                                                                                                                                      |
| Merge parents                                       | `565b3bd15cbb7660250e53b2421915d2f6bdebc5`, `2a93885bac5798a79d55069a0b5dc3e53c6176bc`                                                                                                                                                                          |
| Branch                                              | `codex/t3-sync-2a93885bac-20261008`                                                                                                                                                                                                                             |
| Exact worktree                                      | `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-t3-sync-2a93885bac-20261008`                                                                                                                                                                                |
| Upstream fetch remote                               | `https://github.com/pingdotgg/t3code.git`                                                                                                                                                                                                                       |
| Upstream push boundary                              | `upstream` push URL is `DISABLED`                                                                                                                                                                                                                               |
| Owned publication repository                        | `https://github.com/ScientFactory/scient-desktop.git`                                                                                                                                                                                                           |
| Owned-main catch-ups                                | `ae3f8171fc548a9cb28d43dafba227279f6ddc52` retains main `31fc34e78d26ebacb543cf9d6471daa5ffc5a949` (#483 composer setup); `458b041da22fb1985b461196f78530e8dc30c153` retains main `d0a6976beae37bdabc30e7ccdf4c895c6498c82f` (#482 provider release isolation). |
| Frozen source snapshot                              | `3205e2e16c1d377a0869c9d12731115027520e9b`; tree `04c0429a7a5129b0f4b7631fbf125ae4926b581c` (initial complete aggregate revision, exit 1; later fixture repair committed at `1dd32f72f5`)                                                                       |
| Previously qualified runtime candidate              | `d99d176c1b13446ae6bccf8dee864d99a50d6661`; tree `b65ddfdf12b6ec65363c20fa48c380979726667f` (final runtime source; documentation-only descendants reuse explicitly bound scope evidence)                                                                        |

Inputs come from `plan.json` and the actual merge commit parents. Every official commit below is retained in the merge ancestry; held activation is not omitted upstream history.

## 2. Complete upstream advancement inventory

Each of the 63 `plan.json` commits appears exactly once in the following composition groups. The descriptions record integration intent/source composition; final executed gate results are separate below.

### 2.1 Queue, rollback and thread settlement

Adopt held delegated completion fixes, rollback/send serialization and prompt settlement while preserving Scient exact-attempt queue holds, accepted Resume receipts, FIFO and separate child/parent lock ownership.

| Official commit                            | Advancement                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `0bfd9dd19d0c9418a936190525ec8f4c4fdae09b` | fix(server): held queued wakes no longer keep delegated tasks running (#17028)    |
| `c28cd905572e2a28934a6229d88bcf2975963032` | fix(server): a message sent during a rollback no longer undoes it (#17079)        |
| `0ce6b9deb0c3f6b4dd9df7ed809f7acb9d237ae0` | fix(server): threads settle as soon as branch status sees their PR merge (#17148) |
| `37eaf5d293ef83ce86d2ce9a1583792696c82bbc` | fix(server): an agent can settle its own thread when its turn ends (#17145)       |

### 2.2 Bounded snapshots and database reads

Adopt omission of duplicated local turn items and release database read ownership before shell decoding. Compose the omission query with Scient negotiated compact HTTP references; restore local records once, preserve frozen inherited copies and old unmarked clients.

| Official commit                            | Advancement                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `28f5516a9acfcfc1e203487e78869a406fd23b76` | perf(mobile): omit duplicated turn items from bounded thread snapshots (#15385)           |
| `1f31906c8e3003b2a9d7118c4da163544fa86586` | fix(server): shell snapshots no longer block other database reads while decoding (#17141) |

### 2.3 Mobile visibility, cache and allocation work

Adopt hidden-screen clocks/subscription pauses, row/cache reuse, small move-menu indexes and memory-warning GC. Preserve native state and selection ownership; this does not activate a distribution channel.

| Official commit                            | Advancement                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `eb17e0db2bd075e71b4015dc57588e7f838cbcdc` | perf(mobile): pause elapsed-time timers on hidden thread screens (#15397)     |
| `65404eb75de9233c9d1068ddfd09bacfc3b0465b` | fix(mobile): pause hidden home thread list updates (#15705)                   |
| `12a4c057f3d6880c611630ccdc0c8c7f2cd23f72` | fix(mobile): skip move indexes for empty and single-thread sections (#16115)  |
| `8a1fc4149ae7b41e7d3d93f1b51dd9aeb38c4282` | perf(mobile): reuse encoded rows in shell cache saves (#16129)                |
| `6651aaab38c6814ed7bba3e805a1ec7a01870b55` | perf(mobile): skip showcase subscriptions in normal builds (#16131)           |
| `6eed953a060213630af0d7e3cd9a664bd85f7ced` | perf(mobile): remove unused Home project sorting (#16177)                     |
| `7873504964c3008ed2a87ada7be62d611e7a281a` | perf(mobile): reduce move-menu index allocations (#16256)                     |
| `6c1ce06996979fcfe120ec8c8cb4f78a5c8a7365` | perf(mobile): skip impossible thread-key lookups (#16263)                     |
| `c001e191a19db32199ad75ccea219f729f9db7c4` | fix(mobile): collect UI runtime garbage on iOS memory warnings (#16296)       |
| `b402f5fc65f6f4554266dea385a7da7ff353f028` | perf(mobile): reuse the settled sort when settled rows are unchanged (#16369) |

### 2.4 Mobile Git refresh and native menus

Adopt stable Git refresh signals/reconnect repair and current menu callbacks. Retain environment capabilities and explicit action permissions.

| Official commit                            | Advancement                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `70eeb3996d557a2e553f817c8e123bf79bbd378c` | fix(mobile): stop refreshing Git status on streamed thread updates (#15893) |
| `5c2798d47eb41d5d659b8d2189781fcb06536a5f` | fix(mobile): stop Git sheet refresh loop (#16305)                           |
| `4fec120b75bb397bda3c09b7317f79c1d26811c0` | fix(mobile): refresh Git status after reconnect (#16329)                    |
| `833a03afe32b2f332ab19ce72c0e0dc3cf72c341` | fix(mobile): update the iOS Git header menu when status changes (#16330)    |

### 2.5 Mobile file/review/navigation surfaces

Adopt native file/header insets, incremental grammar-aware highlighting, diff/glass alignment, native stack/swipe repair, Add environment composition and nested Android HTML scrolling. Cloud connection additions remain config-gated under existing Scient policy.

| Official commit                            | Advancement                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `e803242d936af3e052757d59ab32bc7c4fcc2390` | fix(mobile): restore file viewer insets and glass header (#17073)                      |
| `33afd5a5aa361890c9ce22479e8f52f6b18248aa` | perf(mobile): highlight source files in small batches that keep grammar state (#16729) |
| `97a65a3121c11801a877897928efc51ef40fa49f` | fix(mobile): align diff scrolling with glass headers (#17085)                          |
| `30cc788975500a8c00d32a50f348174d1ce578d1` | feat(mobile): redesign the Add environment sheet (#17092)                              |
| `a6ec88f7a716fc421bd22c2484881c44110f9375` | fix(mobile): keep native screens ordered during stack pops (#17231)                    |
| `61b9790816a8af359ab7e8ba0b52a3481353b18d` | fix(mobile): HTML pages in a thread no longer trap scrolling on Android (#17211)       |
| `805967a878e6804d58c151f29d2a3d0a06828fd1` | fix(mobile): preserve navigation after native swipe back (#17268)                      |

### 2.6 Quotes, scratch threads, composer and provider list

Adopt quote/comment details and source action, scratch machine labels in both Scient row modes, token-count compact chip and copy/fork order, provider-list title action. Preserve Scient file quote/comment/source lifecycle, reader behavior, project picker/footer and managed connection flows.

| Official commit                            | Advancement                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `12865b4a73c23bb402717d5f592dcd954ed196e5` | feat(web): quote chips show what you said about the quote (#15703)           |
| `ff9eb8bd0c8e71f98969a58d5789889e07b57c8b` | feat(web): projectless threads show their machine in the sidebar (#17022)    |
| `0647c481017f25ddff2ec1dff68ef3944489b6db` | feat(web): compact-before-send is a chip that shows the token count (#17127) |
| `2ea7684d563fe0ebbe9144dbfd6b0eade7eaf49a` | fix(clients): copy button is back in its old spot, before fork (#17137)      |
| `5e2225671f705fcd33f1ea5591b79ba612fb6974` | feat(web): Add provider button sits with the provider list (#17152)          |

### 2.7 Pull request surfaces and linking

Adopt whitespace-independent file statistics, constrained toolbar/commit menu, non-Git-folder linking and immediate stack-dialog close. Preserve Scient explicit workspace/environment source ownership and existing single/multiple-link contracts.

| Official commit                            | Advancement                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `6053a7878d24e5fd596d2b417ed94964a4b9c1c6` | fix(web): PR file stats ignore the hide-whitespace toggle (#16162)                |
| `ed27eb724b4d7963b59de8fd2e51d6b877004163` | fix(web): PR code toolbar no longer overlaps in narrow panels (#15561)            |
| `98b5e1bef3c8d933d7ad826f837086a506a3732f` | fix(web): PR commit menu no longer stretches across the window (#15560)           |
| `a4c9494b0e3606775cc5fc929fc138399288bd43` | fix(web): link pull requests to threads in folders that aren't Git repos (#15946) |
| `eb1cf7bd0efba7364d53907036f5b7eefb379c39` | fix(web): stack merge dialog closes as soon as you confirm (#17116)               |

### 2.8 Usage filters and refresh performance

Adopt provider filtering, progressive cached/final refresh, unchanged Antigravity-source reuse and Cursor history loading work. Preserve explicit accounting opt-in and authoritative external Spend; execution-provider filter is not applied to Spend.

| Official commit                            | Advancement                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `85a41391e9625d760f5bb2294834c38f42bbf5b8` | fix(web): Usage breadcrumb stays centered on small viewports (#15552)                                    |
| `4d1f24ba4123279708e169fcb196f78da8f11351` | fix(usage): repeat usage scans no longer decode unchanged Antigravity databases (#17139)                 |
| `13c5328dd02ab0f5863f7d46455efc8dc243d4ce` | feat(web): filter the Usage page to just the providers you want (#16970)                                 |
| `9381533771ef50d58304f79fac2b74ebd8932be7` | fix(usage): Cursor account history loads about 4x faster (#17140)                                        |
| `85975585579188be20f46d96b4972ce46c33f4bc` | perf(usage): the Usage page shows numbers in under a second and dims only what is still loading (#17147) |

### 2.9 Thread Find, shared Markdown and centered layout

Adopt Find over messages/plans with read-authorized RPCs, source index, virtual navigation, disclosures, search styling and shared Markdown moves. Compose Scient math/rich-fence/file-citation canonical search, skill labels, reader continuity and centered gutter. Preserve scientific renderer owners and HTML/file authority.

| Official commit                            | Advancement                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `647d8affa78c848c2a55c3e00ed14af9a9eca58e` | fix(web): command palette scrollbar no longer clipped at the top (#17035)            |
| `73e097b8c86000ddc4b38926ba86e1595109d78e` | fix(web): workspace page headers can no longer grow past the top-bar height (#17086) |
| `12069eefd707f78eafc27812027c994eea0613cf` | feat(web): find messages and plans in the current thread (#10439)                    |
| `07a8b9ece40bc20a5f84ce78d12f621518065863` | fix(web): centered scrollers no longer shift when the scrollbar appears (#17077)     |
| `62a5d3720f82f2dc3ace48fcb26c90c6e3976b50` | fix(web): distinguish thread search matches from code tints (#17263)                 |

### 2.10 Terminal scrollback and snapshots

Adopt upstream Ghostty multicell/selection ABI, scrollback navigation and snapshot mechanics while keeping Scient terminal surface/lifecycle ownership.

| Official commit                            | Advancement                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `9a3070bcf023c3c025633659addeef4cf628133a` | feat(web): improve terminal scrollback navigation and snapshots (#17091) |

### 2.11 Provider adapters, native continuations and catalogs

Adopt completed child effort/speed, optional Muse, ACP argument-only persistence batching, Pi owned continuations/deferred exposure/native editor answers/workspace commands and native legacy classification. Compose through Scient captured policy, generation fence, rollback barriers, canonical tool projection and passive probe rules; retain OMP/Droid and existing model/reasoning preferences.

| Official commit                            | Advancement                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `57f96e69d39669f47e7310062222cd67adbb4912` | fix(lineage): keep agent effort and speed after completion (#16925)                     |
| `d6f47ff9725f0902b526f854519cb7e92dcee52f` | feat(providers): run Muse Code as a native provider (#17082)                            |
| `10e29a26c289140b8f2312045c1ce0c278c7fe1a` | perf(server): ACP tool updates no longer persist a snapshot per streamed chunk (#16682) |
| `f999eb2a8e7d8db74d4f4ab7dd66f86163e1a226` | fix(server): Pi extension wakes get an owned continuation turn (#17214)                 |
| `de72286ee5777319fde054e7a82023916ce6f481` | fix(server): Pi discovers optional T3 tools on demand (#17220)                          |
| `e8f5850b824572bab76bf810696f875eb648eff9` | fix(server): Pi editor dialogs prefill the answer composer (#17206)                     |
| `0b6ec43c54165a87941b7a070849be8979646040` | fix(server): Pi discovers workspace skills and commands (#17190)                        |
| `fd25c42ae6e56a82be7219950a746572b1c4d0e9` | fix(server): keep newly discovered models out of legacy groups (#14314)                 |

### 2.12 Desktop identity and remote IDEs

Adopt RFC-compatible Electron runtime name and JetBrains SSH launch support. Keep Scient display/About/menu identity and D4 state paths; remote editor URL construction remains explicit and covered by upstream cases.

| Official commit                            | Advancement                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `a0066d5cb7d18abd786c1c23bf835f898490fd37` | fix(desktop): generate valid User-Agent that follows RFC 9110 guidelines (#17264) |
| `df616cc5491dcc7dd80d3ade8decd88f7a652220` | feat(editors): open remote projects in JetBrains IDEs over SSH (#17271)           |
| `740f591221bd9651f172237d68b7daba9d050dbd` | test(desktop): expect JetBrains IDEs among remote editors (#17291)                |

### 2.13 Pairing, GitHub Enterprise and relay machinery

Adopt integer-bound pairing flags, authenticated GitHub Enterprise host recognition and relay version/fallback mechanics. Preserve configured PATH/override runtime authority and existing cloud, telemetry, updater and release boundaries; no new authority activation.

| Official commit                            | Advancement                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `4daec109cdf8e3e92b392017d7564e735e54f6fd` | fix(server): pairing tokens work on Node versions that cannot bind booleans (#16730)  |
| `cdd331b6c3f78bf24b039b09937b837d2d71a4e7` | fix(server): recognize authenticated GitHub Enterprise hosts (#11059)                 |
| `2a93885bac5798a79d55069a0b5dc3e53c6176bc` | fix(connect): relay client updates itself and skips incompatible cloudflared (#17275) |

### 2.14 Provider maintenance guidance

Integrate provider onboarding checklist, with Scient managed lifecycle, probes, naming and compatibility policy retaining ownership.

| Official commit                            | Advancement                                                     |
| ------------------------------------------ | --------------------------------------------------------------- |
| `a65b43892f14bd6c1280296a37a11bd5234be00d` | docs(internals): add a checklist for adding a provider (#17229) |

## 3. Meaningful composition and semantic corrections

### Provider/native execution ownership

- **Pi:** incoming wake ownership is composed into Scient's existing buffered-work admission owner. Native continuations capture source session, instance, model/options and runtime/workspace policy; generation invalidation and rollback barriers survive. Joining prompts require equivalent captured policy. Confirmed native fork identity is emitted before optional entries probing; command-level probe rejection and transport failure remain distinct. Native dialogs remain answerable during rollback.
- **Pi discovery/tools:** disabled providers do not spawn probes; workspace inventory overlays only skills/commands. Custom model launch policy and passive isolation remain. Modern Pi defers optional canonical Scient tools only when builtin search is qualified; replaced/disabled search falls back to direct exposure. Pi before 0.99 retains canonical tools plus the historic `mcp__t3-code__` alias directly; modern Pi hides both `mcp__t3-code__` and `mcp__t3_code__` aliases. They forward to the same endpoint/credential, not another tool authority.
- **Muse:** upstream SDK driver/adapter/catalog/maintenance integrated, builtin disabled by default. Installed system CLI and native CLI login are the supported path; no new managed installer or browser sign-in action is invented. Public Scient naming and `scient` MCP session server name replace product-facing T3 copy; protocol compatibility identifiers are retained where required. Passive probes exclude inherited API-key overrides and shell/writes; ordinary sessions disable automatic updates. Recognized native launchers retain an explicit update action; standalone/Windows binaries remain manual-only. Scoped Scient skills are now admitted through the existing `ProviderSessionManager` issuer and Muse `sessionMcp` channel (`mcpSessionInjection: true`), with selected release/trust filters and `skills:read` scope. `configureMcp:false` withholds credentials, native MCP configuration and device environment on both start/resume. Private core awareness is explicitly `unsupported-no-private-system-seam`: MCP tool injection does not manufacture a private system-prompt channel or rewrite authored user text. See `final-muse-injection-review.md`.
- **ACP/Codex/catalogs:** argument-only ACP persistence sampling does not delay status/title/visible output/terminal updates or Droid forced terminalization. Completed native children retain effort/speed. Existing Scient native model family/legacy metadata, approved defaults and explicit user choices remain; duplicated clean-merge Antigravity slugs were removed. OMP, Droid, Scient Agent and managed lifecycle consumers retain their existing implementations.

- **Native workspace identity:** a real strict Muse second-turn replay exposed false workspace changes when `/var/...` and `/private/var/...` named the same directory. `ProviderSwitchService` now compares realpaths only when spelling differs; both lookups must succeed and match. Distinct roots or lookup failure preserve the conservative restart/reject policy. Saved raw workspace/runtime policy and all instance/model/continuation checks remain unchanged; no recorded restart was fabricated to conceal the defect (`b85135803327a255fad5f9ad1d8a67c0e5c373bc`, follow-up service-shaped test stubs `7d631254969ddf58276725ecbbe6f354f143c2e0`; `muse-multiturn-diagnosis.md`).

### Queue, frozen history and transport

- Child terminal queue hold/promotion occurs under the child lock before parent finalization takes a separate later parent lock. Scient exact-attempt accepted-Resume reconstruction and held FIFO semantics remain; no new queue ledger or nested lock inversion is added.
- Rollback provider/run/node/checkpoint events and replay-safe attachment-prune outbox retain atomic `writeWithEffects` under the command executor. Frozen inherited payloads remain outside prune candidates.
- Frozen copied payloads use child-owned immutable source identities for Find/history; upstream native-fork ancestor timelines retain their existing semantics. Legacy projection hydration occurs before history/search reads.
- Bounded snapshots compose upstream omission query with Scient's explicit compact header/reference union: decode canonical references first, then restore omitted local records exactly once, then discard transport marker. Old clients without opt-ins retain the full legacy response shape.
- Find RPCs are mounted once in the conversation group under orchestration-read authorization. Malformed history cursor decoding remains distinct from valid missing-anchor fallback; actual HTTP route proof cases retain both.

### Clients and scientific rendering

- Generic Markdown, paths, file labels, directives, artifact templates and plan helpers move atomically to shared owners. Untouched Scient consumers were cut over; stale compatibility exports and generic clones were not restored. Final repair `1de7f8f93dc63ddc77e3416d1440223e09e4fa56` removes the last duplicated web Windows-destination helper: document/chat grammar now shares the actual generic function through one paired Scient export. Profile tests compare exact plugin identity/order, not stale source-array names.
- A dead generic `chat/MermaidDiagram` auto-merge resurrection was removed, together with the redundant direct DOMPurify dependency. Actual chat and PR descriptions route through `ChatMarkdown → ScientRichFence → MermaidDiagramCard`, retaining strict rendering, isolated no-network CSP and SVG external-resource filtering. Import reachability informed ownership; behavioral proofs remain separate.
- File citation chip and shared Find index use one `composerCitationLabel`. Shared sanitizer preserves the existing citation protocol; invalid/unsupported/unsafe hrefs still require parser validation. Captured workspace paths do not become current filesystem authority.
- Find over KaTeX and Mermaid/Plotly/Vega uses one canonical source per scientific object while visual renderers remain mounted. Only selected hidden source reveals through `beforematch`; transient math source unmounts when Find closes, is excluded from speech and Markdown copy, and uses duplicate-safe segment keys. Cross-formula DOM ranges may enclose visual KaTeX descendants; `Range.toString()` is not a canonical-source assertion.
- Scient reader anchors, bounded-follow suspension, fork handoff and managed skill labels remain. Both sidebar row modes supply scratch machine labels. Pinned project picker actions and existing projectless controls are retained.
- Actual compact-before-send is adopted, not just its chip: ordinary eligible sends compact then queue their normal turn through native server admission. Explicit actions, captured queue edits/retries and multi-model sends retain original payload authority. Manual compact draft protection remains; full-history choices reset on accepted normal admission and survive failure.
- Progressive usage and provider filtering preserve explicit external-accounting opt-in. Spend remains external account truth, so execution-provider filter is not shown there. Existing extracted Scient chart geometry stays authoritative.
- Electron native HTTP token name strips parentheses from the existing Scient display name only; About/menu preserve `Scient (Dev)` while runtime uses `Scient Dev`. Packaged Scient identity and state-path isolation remain. Stale display-name fixtures were corrected without production changes.
- Settings observation retains scoped native directory-watch hints and adds one approved, authoritative-path metadata fallback. A bigint `lstat`/following `stat` baseline is acquired before startup cache refresh/readiness, then one scoped 250ms sampler detects link identity, target identity/timestamps, missing/dangling transitions and atomic replacements. Native hints and metadata changes share the existing 100ms debounce and semaphore-protected cache owner. This deliberately supersedes the earlier no-polling design; native acquisition is not advertised as OS-ready. See the corrected findings for cost, failure policy and proof limits.
- A real path relocation regression in shared `fileLinks.joinPath` was repaired: trim `/` only on POSIX, preserving literal trailing backslashes; Windows still trims both separators. Original terminal/Markdown path assertions remain, with shared POSIX/Windows/UNC line-and-column cases added.
- Muse is now present in Scient’s extracted conversation/provider picker, in canonical order with existing non-default `new` marker. Existing providers and saved/default model choices remain; optional catalog presence does not enable Muse. Settings retain incoming Muse-only Beta, without reviving Pi/ACP Early Access.
- New `chat.find` adds one key collision. The fixture retains the exact four collisions on Mac/Windows; real document host proof uses actual `resolveChatShortcutCommand` in capture phase, asserting `defaultPrevented:false` and no app command inside the editor, with `chat.find` outside. Only Escape dismissal bubbles. No shortcut behavior was changed to satisfy a fixture.
- Owned-main PR #482 was caught up as a literal merge after bounded provider-release isolation review. All 31 incoming files were byte-identical to main in the merge index. Per-provider publication isolation, qualified Cursor predecessor ordering, and exact ACP process-group cleanup remain; affected qualification is recorded separately from the earlier frozen aggregate.
- Owned-main PR #483 was caught up without replacing its composer Install/Sign-in/Manage flows, restored disabled/provider setup entries and Scient Agent host prerequisite path. That owned catch-up is separate from the 63 official commits and does not add provisioning authority.
- Incoming centered-scroller lint contract is applied to existing Scient scrollers using the shared gutter utility. Onboarding provider list remains independently bounded; no whole-page scrolling change was introduced for the list.

## 4. Preserved authority and held activation

Accepted bounded source reviews (`final-policy-review.md`, `final-provider-review.md`, `final-server-review.md`, `final-client-review.md`, narrow follow-up/Muse reports and the independently accepted final client/shared repair) establish the following reviewed composition. They do not establish live-provider delivery or a published-build result.

| Boundary               | Source-confirmed disposition                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud/sharing          | `cloudEnabled = false`; Codex subscription sharing disabled. Relay/public config remains opt-in and secure-config gated. Production relay, mobile EAS and showcase workflow holds remain.                                                   |
| Telemetry              | Owned outbound telemetry/consent/OTLP guards unchanged; analytics defaults off.                                                                                                                                                             |
| Provisioning/auth      | Scient lifecycle remains sole managed install/sign-in/provenance authority. Muse adds system CLI/native login only; no second installer or browser auth flow.                                                                               |
| Tools/native sessions  | Per-instance/captured runtime and existing credential issuer retained. Muse scoped skills enabled through native MCP; private core awareness explicitly unsupported. Pi compatibility aliases share one endpoint/credential.                |
| Queue/fork/history     | Exact-attempt holds, accepted Resume receipts, frozen payload identities and atomic rollback/prune ownership retained.                                                                                                                      |
| Updater/release        | Owned updater/release automation already active where qualified; alignment changes no publication authority. Workflow/lifecycle/telemetry/cloud/updater/release guard sources byte-unchanged from owned base at the policy-review snapshot. |
| Scratch/create-project | Existing scratch conversations retained; create-from-name remains disabled beside Scient’s own flow.                                                                                                                                        |
| Upstream push          | `upstream` push URL is `DISABLED`; publication uses owned `origin`.                                                                                                                                                                         |

Candidate launch safety settings are a separate runtime envelope. The worktree-local profile and checked revision are recorded during the PR handoff; these runtime choices are not source defaults or shipped release-policy changes. Root rechecked protected-source equality at final runtime source `d99d176c1b13` against caught-up main `d0a6976bea`: workflows, managed lifecycle, telemetry, desktop config/Clerk/observability/updates and shared Codex/desktop identity scopes were unchanged (`protected-source-metadata-final.json`).

## 5. Local qualification and acceptance limits

The complete uncached serialized test graph at `3205e2e16c1d377a0869c9d12731115027520e9b` (tree `04c0429a7a5129b0f4b7631fbf125ae4926b581c`) finished with **35,094 passed / 2 failed / 234 skipped**, exit 1 (`checks/all-tests-qualified-final.log` and `.json`). Its two failures were the Usage fixture lifetime inversion and existing dangling-settings-link reload timeout. Later repairs and focused evidence are recorded below; they do not convert that aggregate into a pass. Earlier failed server/web attempts remain in `checks/server-tests-final.log` and `checks/web-unit-final.log`.

Independent exact-source/dependency review (`final-test-reuse-review.md`) supports reuse of 30 nonserver package results, replacing the changed provider-runtime and scripts packages with their newer full-suite results: **22,570 passed / 46 skipped**. Twenty-seven packages are byte-unchanged from the initial aggregate; shared changed only ownership comments and additionally passed the focused path gate. Lockfile, manifests, global test setup and affected cross-directory dependencies were checked. This is component evidence reuse, not a new all-workspace run. The final server suite at `d99d176c1b13` subsequently passed **968 files, 12,566 cases**, with 56 files / 188 cases skipped (2,116.81 seconds, exit 0). Replacing the failed initial server row and the two changed nonserver rows yields **35,136 passed / 234 skipped / zero failing cases** across the 31 package results. This is a qualification assembled from the complete initial graph and justified affected-scope reruns, not a fresh simultaneous all-workspace run.

Completed checks at `1dd32f72f5` are reused only for unchanged owners: Chromium layout 33 files / 289 cases passed, provider-runtime 194 passed / 2 skipped, and scripts 662 passed / 1 skipped. Their exact commands, starting tree and timings are retained in the correspondingly named JSON/log pairs. Root verified those scopes unchanged at final runtime source `d99d176c1b13` (`source-evidence-reuse-metadata-final.json`); complete final server and uncached builds passed; bounded stress evidence is recorded below; app/PR handoff is a separate gate; fixture counts do not establish live-provider delivery or user acceptance.

| Qualification group       | Existing evidence and required final binding                                                                                                                                                                                                                                                                                         | Status                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Static                    | At `d99d176c1b13`: all 32 uncached typecheck tasks, formatting, lint, Knip and brand passed. Typecheck: 0 errors/warnings, 420 suggestions; lint: 1,298 advisory warnings. Seam and introduced-history provenance checks passed. No baseline attribution asserted.                                                                   | **PASSED**                                                      |
| Complete unit/integration | `3205e2e16c1d` complete graph: 35,094 passed / 2 failed / 234 skipped, exit 1. Usage and settings repaired without weakening assertions. Final server: 12,566 passed / 188 skipped, exit 0. Exact unchanged-package reuse plus full changed-package reruns gives 35,136 passed / 234 skipped / zero failures across 31 package rows. | **PASSED — affected-scope requalification and exact reuse**     |
| Provider/authority        | Existing continuation/rollback/identity, ACP/Droid, Muse scoped injection/opt-out/awareness/replay proofs; provider-runtime at `1dd32f72f5`: 194 passed / 2 skipped. Root verified this provider-runtime scope unchanged at `d99d176c1b13`; final complete server qualification passed.                                              | **PASSED — server and runtime scope bound**                     |
| Queue/history/transport   | At `d99d176c1b13`: wire/history suite, 18 files / 386 cases; six queue/rollback/Pi files, 161 cases each, passed three consecutive serialized runs.                                                                                                                                                                                  | **PASSED — bounded synthetic stress**                           |
| Client/shared             | At `3205e2e16c1d`: web 937 files / 11,494 cases, mobile 245 files / 2,252 cases, desktop 1,640 passed / 43 skipped cases. At `1dd32f72f5`: Chromium layout 33 files / 289 cases passed. Final diff proves these client scopes unchanged at `d99d176c1b13`; results are reused from their recorded source revisions.                  | **PASSED — exact unchanged-source reuse bound**                 |
| Build/product gates       | Scripts at `1dd32f72f5`: 662 passed / 1 skipped; brand and seams/provenance passed at `d99d176c1b13`; divergence advisory reviewed; all six uncached build tasks passed; fresh-profile macOS desktop smoke passed after removing inherited `ELECTRON_RUN_AS_NODE=1`.                                                                 | **PASSED**                                                      |
| Source review             | Accepted bounded client/provider/server/policy/follow-up/Muse/Usage source reviews; final settings helper/host/proof review independently accepted; exact source hashes match `d99d176c1b13`. No remaining actionable source finding reported.                                                                                       | **ACCEPTED — final runtime source bound**                       |
| Clean candidate           | Fresh worktree-local profile; exact head/bundle/ports/process ownership and readiness require a separate PR handoff and external startup record. Startup is separate from feature/visual acceptance.                                                                                                                                 | **Separate handoff gate**                                       |
| PR/hosted CI/user visual  | Draft PR and CI links in publication record; user visual review of clean app                                                                                                                                                                                                                                                         | **Separate acceptance gates — visual review reserved for user** |

### Final commands and stress bounds

All final runtime gates below started with clean status at `d99d176c1b13446ae6bccf8dee864d99a50d6661` / tree `b65ddfdf12b6ec65363c20fa48c380979726667f`, Node 24.19.0 and pnpm 11.10.0 on macOS. Exact command arrays and durations are retained in the named evidence files.

- Root static: `pnpm exec vp run -r --no-cache --concurrency-limit 2 typecheck`; `pnpm exec vp fmt --check`; `pnpm exec vp lint --report-unused-disable-directives`; `pnpm run knip:check`; `pnpm run brand:check`.
- Complete server: from `apps/server`, `pnpm exec vp test run --maxWorkers 1 --no-file-parallelism` (`server-settings-final`, 2,116.81 seconds).
- Complete build graph: `pnpm exec vp run --filter './apps/*' --filter './packages/*' --filter './oxlint-plugin-t3code' --filter './scripts' --no-cache --concurrency-limit 1 build` (`build-release-final`, six tasks, 43.13 seconds).
- Native launch smoke: `pnpm run test:desktop-smoke` (`desktop-smoke-env-final`, 10.55 seconds), fresh external profile and safety envelope; inherited role/home/URL and `ELECTRON_RUN_AS_NODE` removed. Eight-second survival and graceful drainage passed. This gate does not establish backend or renderer readiness; those are checked during candidate handoff.
- Wire/history: `pnpm run test:perf:v2-wire`, 18 files / 386 cases (`wire-stress-final`, 7.38 seconds).
- Three sequential runs of `NativeQueueHoldPolicy.integration`, `CheckpointRollbackService`, `boundedSnapshotTransport`, and Pi `Admission`, `Recovery`, and adapter suites with one worker / no file parallelism (`queue-rollback-pi-stress-1` through `-3`): 161 cases each, zero failures.
- Exact-base/target/head Scient seams and current-main/official introduced-history provenance passed; protected-source equality and advisory findings were independently reviewed. Whitespace checks accompany final documentation commits.

Transport-budget fixtures contain 600 rows with 8,192 output bytes each. Existing bounded snapshot (131,072 bytes), projected command event (1,024 bytes), and current-send (1,024 bytes) ceilings remain unchanged. Queue/rollback/provider fixtures exercise controlled receipts, holds, continuation and failure boundaries. This is bounded synthetic stress and repeated lifecycle testing, not real-account vendor load, arbitrary fault injection or packaged-platform performance proof. Headless Chromium layout passed 289 cases; it is not an assistant visual review.

### Corrected findings and remaining qualification limits

- **Pi’s seven full-suite failures:** five stale `details.server: "t3-code"` expectations, one expanded across three resource cases, mismatched the existing Scient bridge’s `"scient"` identity. Only those five expected strings changed. Full native equality, image/resource bounds, metadata, error and permission assertions remain; this is a fixture correction, not a production tool rename (`providers.md`). The complete `3205e2e16c1d` server run subsequently had only Usage/Settings failures; the final complete server suite at `d99d176c1b13` passed.
- **Muse:** exact outbound client title/runtime branding fixture adaptation preserves native fields, inbound events, model/effort and user text. Separate actual defects in skill/session injection and equivalent-workspace switching were repaired and independently reviewed. The latter was reproduced with the strict replay, not dismissed as a branding fixture failure. Private core awareness remains explicitly unsupported.
- **Client/shared final repairs:** the fourteen-path `1de7f8f93d` follow-up repairs real path semantics and Muse picker omissions, retires duplicate grammar ownership, and faithfully adapts relocated plugin/idle label/collision fixtures. Independent review rejected the first weaker bubbling Find fake; corrected capture-phase proof uses the production resolver. No deciding assertions or skips were removed.
- **Editor performance:** parallel web run measured 70.65 ms typing p95 over the unchanged 64 ms ceiling. The unchanged five-case performance file then passed isolated serialized execution (`checks/markdown-performance-isolated-final.log`). No limits were increased or skips added. This is bounded qualification evidence, not proof that contention alone caused the overrun or that the packaged app satisfies the stricter painting/typing budget.
- **Usage cache fixture lifetime:** commit `1dd32f72f5` nests the Usage services inside the provided state-directory lifetime and adds a finalizer-order proof, retaining pricing, deleted rollouts and exact legacy bytes. The real negative control removes only that inner scope and fails with `ENOTEMPTY` plus `ENOENT`; the corrected whole Usage file passes 28/28. The combined Usage/Settings run still exits 1 (114 passed / 1 failed), only for Settings. Both deciding runs are controlled WIP variants at base HEAD `458b041da22f`, not pristine final gates. The earlier misnamed negative control was actually a positive run after a wrong-cwd mutation failed and is excluded from negative evidence. Official target shares this fixture omission, formerly masked by inline persistence. No production leak is established. See `final-usage-scope-review.md` and `usage-v4-scope-diagnosis.md`.
- **Shell snapshots:** stale fixtures injected the old getter, not staged `readShellSnapshot`; outer-read/inner-decode failure and coherent capture/write-race assertions were adapted to actual owner (`final-followup-review.md`).
- **Settings watcher (approved repair, qualified):** the earlier native-only readiness design is superseded. The external Node/libuv Darwin probe, without Effect/cache/debounce, registered 64 parallel directory watches and immediately performed sibling-temp-file atomic replacement: only **1/64** raw settings callbacks arrived within the unchanged two-second bound (`checks/native-settings-watch-probe.log`). Matching libuv 1.52.1 FSEvents source admits directory handles asynchronously and reschedules the loop-wide stream with `SinceNow`; JavaScript watch return therefore proves neither OS readiness nor gap-free rescheduling. This establishes the native observation boundary's insufficiency, without assigning every historical application timeout to that interleaving.
  - The alignment integrator approved one service-owned 250ms metadata fallback on the authoritative settings path, retaining native watches as low-latency hints. Baseline acquisition precedes startup cache refresh/readiness. Bigint link `lstat` identity and a following target `stat` include device/inode/size/nanosecond mtime/ctime, detecting same-target link replacement, repointing, dangling/reappearance and atomic replacement. Four sampling iterations per second require one regular-file or two symlink metadata calls per iteration (up to eight calls/second); unchanged metadata performs no content reads.
  - Metadata and native hints merge into the same existing 100ms debounce/semaphore owner, avoiding a second cache/persistence authority. Permission failures retain the last successful fingerprint and log transitions rather than every sample. Consumer failure closes native and fallback resources together under the existing logged nonfatal stop policy; no implicit observer restart owner is introduced. Disposal/interruption closes resources. A lost native link event may leave the native target handle bound to the old destination; authoritative-path sampling still observes current data, but does **not** claim native retargeting or OS readiness.
  - Quiet-native proofs also caught an actual implementation error: Effect 4’s `Stream.filterMap` expects Filter/Result rather than Option, so the initial sampler silently dropped metadata changes. Typed Some filtering plus value mapping repaired emission. The earlier clock-only explanation was incomplete; failed and terminated attempts remain external evidence. No assertion or timeout was weakened.
  - All historical failures and intermediate 94-case evidence remain; the later destination-case timeout was not dismissed as contention. All 99 focused cases passed three consecutive stable-source runs (10.59/8.90/9.36 seconds); affected-server types, scoped lint, formatting and whitespace checks passed. Commit `d99d176c1b13` exactly matches the handed-back source hashes. Final whole-repo static checks also passed; the final complete server suite and uncached builds passed; the wire/history suite and three repeated queue/rollback/Pi runs passed; app/PR handoff is separate. The earlier “no polling” statements describe the superseded design, not this approved repair. See `native-settings-watch-review.md`, retained native probe logs, `server-settings-watch-repair.md` and `final-settings-watch-review.md`.
- Other corrected findings remain in logs: lost citation sanitizer protocol, old quote-popover mocks/assertions, stale desktop identity expectations, incomplete local Electron setup and dead generic Mermaid resurrection. Do not erase failed attempts or substitute fixture passing for final aggregate qualification.
- **Unverified:** live provider accounts/native vendor behavior, OAuth, external billing/credentials, microphone and native mobile interaction; unsupported Windows/Linux/native platform gates unless actually executed. Scoped fakes/replays do not prove these.
- No agent visual review/screenshots performed; automated Chromium interaction checks are behavior qualification. Real user migration/profile validation is not claimed; temporary fixtures stay isolated.

## 6. Compatibility/deprecation follow-ups

| Item                                   | Measured scope / trigger                                                                                                                                                                                           | Follow-up condition                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi saved transport selectors           | Older Pi exposes the `mcp__t3-code__` forwarding alias directly alongside canonical names; modern Pi hides both historic prefix families. Deferred exposure is capability-gated.                                   | Remove only after stored selector/loadout migration and old-Pi compatibility decision; do not create another bridge owner.                                                      |
| Effect/compiler advisory enforcement   | At `d99d176c1b13`, typecheck emitted 420 suggestions (0 warnings/errors), and lint emitted 1,298 advisory warnings. Exact totals are external `advisory-metadata-final.json`; no baseline attribution is asserted. | Follow canonical repo invocation and explicit policy; do not mute rules or rewrite behavior merely to make a count disappear.                                                   |
| Shared generic owner retirement        | Known moved client-runtime/web Markdown helpers were cut over atomically; dead generic Mermaid source/direct dependency retired.                                                                                   | Keep canonical shared owner and scientific presentation seams; future imported test/source text must not revive dead owners or treat line/import counts as behavioral coverage. |
| Muse native capability limits          | System CLI provider defaults disabled; native fork/rollback and dedicated Plan mode unavailable. Scoped skills use native MCP; private core awareness is explicitly unsupported.                                   | Qualify account/executable/capability behavior before enabling or introducing managed lifecycle actions.                                                                        |
| Cross-formula highlight representation | Canonical index governs occurrence matching; DOM ranges may contain visual KaTeX text.                                                                                                                             | Assert exact token/occurrence/reveal/copy behavior, not raw Range string equality across visual renderers.                                                                      |

Linked relay minimum-version qualification intentionally rejects incompatible PATH/override executables; compatible user-owned overrides are preserved. Managed refresh/pruning remains limited to an already linked, config-gated host. The final advisory inventory at `d99d176c1b13` reports 541 findings classified `marked`, 11,640 classified `new-debt` and 111 unsupported-format findings, with zero parser/input errors (`divergence-metadata-final.json`). The debt classification compares the whole candidate to the exact official snapshot; it is not a count of regressions introduced by this alignment. Independent manual review covered the 15 changed unsupported-format paths (13 Markdown, one CSS, one YAML) and six changed JSON/lock seams. The other 96 unsupported-format paths and 13 unmarkable seams were unchanged from the owned base. No historical baseline waiver or ratchet activation is asserted (`final-advisory-review.md`).

## 7. Owned-main fork-by-reference composition

Literal merge `b75327a4359cfdb999ab6e0430bdf7af2c984363` (tree `effa90af53b9cead44885cccac98528c7b69da40`) retains parents `240bda731a710931a68c25d0096f9c9b5095ea34` and owned main `91b9b7cb3f2ca0e777436fdca5a913addcb21ab0`. The official target remains `2a93885bac`; later official advances are a separate report, not additional integrated history. The user explicitly authorized resolving this catch-up as alignment after approving the earlier candidate's visual review.

The 127 changed paths comprise 105 byte-identical incoming-main paths and 22 composed or repaired paths. The timeline conflict retains upstream alignment's Find and restore ownership plus main's positioned-thread callback. Main's transactional shared-history capture, attachment lifetime, queue admission, lazy provider fork and rollback remain in the single V2 execution path.

Source review found two automatic-merge defects: history paging/Find read mutable or deleted source rows instead of frozen reference bytes, and inherited indexes lost message/turn metadata required for whole-turn paging and message jumps. One bounded frozen-aware payload resolver now serves these readers; inherited execution/native/detail references remain inert and read ownership belongs to the target fork. Copied, shared and nested history retain their existing semantics. Both deciding tests failed against the exact pre-repair merge blobs and passed after restoration of the repaired bytes; assertions were not weakened. Source deletion, mutation, cached Find, nested history, page cursors and message jumps are covered.

Accepted fork dismissal says Close and leaves the accepted operation running; pre-submit cancellation remains Cancel. Pending fork landing uses native inert behavior while retaining timeline measurement, restoring interaction after positioning or timeout. The new Chromium proof exercises those hooks and wrapper semantics, not the entire ChatView or a visual review.

### Exact affected-scope qualification

All runtime results below bind to `b75327a4359cfdb999ab6e0430bdf7af2c984363` / the tree above, or the exact unchanged pre-commit source diff. Command arrays, scope hashes, timings and retained failures are in the external `checks/catchup-*` evidence. Node 24.19.0 / pnpm 11.10.0, macOS; heavy lanes run serially.

| Gate                        | Result                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static                      | 32 uncached typecheck tasks; formatting, lint, Knip, brand, seams and provenance passed. Advisory warnings are not represented as baseline-clean.                    |
| Web unit                    | 939 files / 11,507 cases passed.                                                                                                                                     |
| Mobile unit                 | 245 files / 2,252 cases passed.                                                                                                                                      |
| Chromium layout/interaction | 34 files / 291 cases passed; no assistant visual review.                                                                                                             |
| Wire/history                | 18 files / 386 cases passed.                                                                                                                                         |
| Conversation package        | 12 files / 103 cases passed.                                                                                                                                         |
| Complete server             | 972 files / 12,563 cases passed; 57 files / 190 cases skipped, exit 0; 2,920.18 seconds.                                                                             |
| Deliberate fork scale       | Both opt-in fixtures passed: 2,500 forks; 50,000-tool history with unrelated SQL progress. Temporary SQLite, bounded synthetic stress, not live-provider throughput. |
| Build                       | All six uncached build tasks passed.                                                                                                                                 |
| macOS native launch smoke   | Fresh external profile, eight-second survival and graceful drainage passed; startup smoke alone is not feature acceptance.                                           |

Contracts, shared, client-runtime, desktop, root manifests and lockfile are byte-unchanged from the earlier qualified head (`catchup-unchanged-owner-reuse.json`); original unaffected-package evidence remains historical reuse. Affected web/mobile/conversation/server results above replace their old rows for this composition. This is not a fresh simultaneous all-workspace run. Independent frozen-reader, server-composition, client and reference-consumer audits reported no actionable source blocker. A legacy unstamped mobile handoff model-label fallback predates both parents and remains a bounded presentation follow-up, not a new authority change.

The same owned candidate was stopped before native smoke and relaunched with its existing isolated state preserved. Recent backend/window logs, exactly one app/backend, owned listeners, both HTTP endpoints and persistence passed (`catchup-dev-app-readiness.json`). No credentials or live profiles were copied; no assistant visual inspection, live vendor account test or native Windows/Linux/iOS proof is claimed. The user's earlier visual acceptance is not presented as a second visual review of this catch-up. Cloud, telemetry, managed provisioning, release and publication authority remain unchanged.

## 8. Publication boundary and review handoff

- **Integration cursor:** `upstream-state.json` and current `UPSTREAM.md` point to the exact locally qualified target and original upstream merge above. This records integration, not main delivery or visual acceptance.
- **Scient PR:** [Scient PR #487](https://github.com/ScientFactory/scient-desktop/pull/487). Its current head and CI remain directly checkable on GitHub.
- **Publication branch:** `codex/t3-sync-2a93885bac-20261008`, owned `origin` only. Publish only a maintainer-documentation descendant of the latest recorded runtime head after its final checks. No upstream push.
- **CI:** hosted checks qualify the final pushed revision; no bypass or claim that all hosted checks are complete until their actual evidence exists.
- **Merge/release:** the user approved the earlier visual review and explicitly authorized the owned-main catch-up and history-preserving merge or queue. Delivery still respects final-head qualification and hosted requirements. No release is authorized by this alignment receipt.
- **Worktree/candidate:** retain for the requested user review; no cleanup or broad process stops are authorized by this receipt.

### Evidence location and owners

External retained evidence is located at `/Users/yaacov/REPOs/ScientFactory/reviews/upstream-alignment-20261008-2a93885bac/`. Commands, head/tree, starting status/diff hash, elapsed time and exit code are recorded in each `checks/<name>.json`, paired with captured output in `checks/<name>.log`. These are local review artifacts, not committed product inputs.

`plan.json`, `start.json`, `merge.log`, `stage-audit.json`, `clients.md`, `providers.md`, `shared.md`, final client/provider/server/policy/follow-up/Muse reviews, `muse-multiturn-diagnosis.md` and `checks/` form the external evidence directory. Root owns the index/dependency/gate/app/PR/final receipt; client/provider/shared agents authored only their reserved source or review paths.
