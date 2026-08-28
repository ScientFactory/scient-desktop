# Scient/T3 divergence, integration, provenance, and retirements

Status: Historical
Owner: Yaacov
Created: 2026-08-28
Last updated: 2026-08-28
Purpose: Records Scient Desktop's T3 ancestry, protected divergences, integration history, open-source provenance, and work later removed, replaced, or deferred.
Doc type: Research evidence

Investigation snapshot: 2026-08-28

## Scope and confidence boundary

This report is about the active product repository:
`/Users/yaacov/REPOs/ScientFactory/scient-desktop`. It was inspected at
`main` / `aa23f1d3b96f6904dcc1a114cc33415fa267315a`, with no pre-existing
tracked changes; the upstream policy files, source tree, tests, Git history,
PR metadata, and third-party notices were reviewed. The only new untracked
output from this investigation is `docs/reports/`.

The aggregate `/Users/yaacov/REPOs/ScientFactory` folder also contains a
separate `Scient` repository, `scient-agent`, website/company material, and
other worktrees. Those are not silently folded into the desktop product
ledger. The separate `Scient` checkout was dirty and is preserved as-is; its
planning material is cited only where it defines the migration policy. This
scope boundary prevents planning or adjacent-app work from being reported as
shipped desktop behavior.

Post-snapshot reconciliation on 2026-08-28 reviewed remote `main` through
`c0baaab2cda29a84682b77b8384bb7542e59a8bd`. PR #189 advances the verified T3
integration point to `c8aba2587d56edbf3b7872987719a12b42031f48`, updates the
current `UPSTREAM.md`, machine state, one dated receipt, and affected
documentation, and preserves the protected Scient seams. It adds no new
Scient-specific capability family. PR #190 then changes a Scient-owned
post-integration policy seam: provider settings favor Models; authenticated
provider email starts visible through a local exception to shared redaction;
and agent Browser plus project Sources access changes from opt-in to default-on
with explicit opt-out. This is a product-default divergence after the upstream
refresh, not donor behavior attributed to Scient. The exact ancestry table and refresh
narrative below remain the original #187 snapshot; current integration work
must use `UPSTREAM.md` and `upstream-state.json` rather than treating that dated
table as the live cursor.

## First principles: what is inherited and what is Scient-owned

T3 is the generic host platform. The official upstream is
`pingdotgg/t3code`, with `main` as the donor branch. T3 continues to supply
the generic application shell, orchestration/event sourcing, provider driver
transport/session machinery, standard project/workspace/editor/terminal
surfaces, and ordinary Markdown/file behavior outside Scient adapters.

Scient owns product identity, product policy, scientific behavior, release
decisions, local scientific data/contracts, and every deliberate divergence.
The practical ownership test used in this investigation is:

1. Is there Scient-owned code/package/contract/test/documentation?
2. Is there a product policy that intentionally changes an inherited T3 seam?
3. Is the behavior protected by a Scient seam manifest, provenance check, or
   explicit `UPSTREAM.md` decision?

If none apply, the behavior is reported as inherited T3 even if it executes in
a Scient build. A T3 feature that is useful to Scient is not automatically a
Scient feature.

Design records are evidence, not automatic product claims. In particular,
`docs/internals/scient-pdf-export-rendering-plan.md`,
`docs/internals/scientific-artifact-studio.md`,
`docs/internals/provider-lifecycle-unification-proposal.md`,
`docs/internals/scient-fork-pr-descriptions.md`, and the D4 migration plan
describe intended or future work in addition to documenting implemented
boundaries. Only the implemented slices identified in the capability catalog
and PR ledger are counted as current capabilities; Artifact Studio, broader
PDF export, full stateful compute, and Overleaf remain explicitly separated.

## Exact ancestry and integration policy

`UPSTREAM.md` and `upstream-state.json` establish these facts:

| Item                        | Evidence                                                                     |
| --------------------------- | ---------------------------------------------------------------------------- |
| Official donor              | `pingdotgg/t3code` `main`                                                    |
| Scient writable remote      | `origin`                                                                     |
| Upstream remote             | fetch-only `upstream`, push disabled                                         |
| Update mode                 | `thin-fork-merge`                                                            |
| Verified bootstrap baseline | `a2ca89aa10f13a2222e08afd98c66285121d5ba2` (`v0.0.32-nightly.20260806.1012`) |
| Bootstrap merge             | `3e8f7bc0e18be4a42c23b021e68bf30e3690bc4d`                                   |
| Integration base recorded   | `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`                                   |
| Reviewed-through cursor     | `dedcd99a9d16240327ce763b885b326aff607bdb`                                   |
| Last refresh merge          | `cfaffd3223157d5c4cf4e4054cca7feee0c5a219`                                   |
| Current Scient head         | `aa23f1d3b96f6904dcc1a114cc33415fa267315a`                                   |

The policy is to refresh remotes/worktrees/open PRs, create a short-lived
refresh branch from owned `main`, merge one explicit official T3 range with
real history, resolve protected conflicts consciously, run focused/full
checks, and advance the recorded integration base only after the exact range
is actually present and verified. No squash/replay is used for ordinary T3
history.

Later observed T3 tips do not move the base automatically. Official T3
projectless-thread PR #5822 is a frozen historical exception used as
provenance for the retired Quick Chat experiment; its imported commits are
recorded with `followUpdates: false`. Scient does not track open T3 PR heads
as update sources.

## Protected divergence matrix

### Product and release authority

Scient keeps its own visible identity, canonical bundle/protocol identity, and
stable release graph. It retains the established `scient-next` user-data
location for compatibility but does not restore the T3 publication authority,
`t3@<Scient version>` dependency, tag/nightly publication, npm publication,
relay deployment, hosted-web aliases, release bot, or AUR distribution.

Scient’s release workflow packages the exact promoted tree, embeds the owned
updater repository, publishes the exact server runtime as a GitHub release
asset, verifies cross-platform updater assets and SHA-512/size manifests,
checks native signing evidence, and keeps signing credentials scoped to the
appropriate OS job. Unsigned preview paths are explicit approval paths.

Evidence: `UPSTREAM.md` release section, `.github/workflows/`, release scripts,
PRs #1–#5, #29, #33, #38–#48, #52, #61–#67, #73, #91–#97, #140, #152,
#168/#172, and #181.

### Provider identity, auth, runtime, and awareness

T3 owns provider drivers, transport, sessions, model discovery, and provider
credentials. Scient owns the lifecycle overlay: independent enablement,
runtime, support, authentication, entitlement, readiness, maintenance, and
operation dimensions; capability-derived actions; managed runtime staging/
verification/activation; assisted setup; Codex proof/recovery; and truthful
provider awareness.

Scient does not create a second provider registry or credential store. It does
not treat browser completion as auth proof, does not expose tokens in
diagnostics, and does not label Cursor/Antigravity as Scient-aware without a
verified delivery channel. Unsupported provider context fails closed rather
than using a hidden message prefix or project/global config side channel.

Evidence: `docs/internals/provider-lifecycle.md`,
`docs/internals/providers.md`, `docs/internals/scient-codex-runtime-auth.md`,
`packages/scient-provider-runtime/`, `apps/server/src/scient/providerLifecycle/`,
`apps/server/src/provider/ScientAwareness.ts`,
`apps/server/src/provider/ScientAwareness.test.ts`, and PRs #27–#28, #58, #130,
#133, #137–#138, #147–#151, #153–#180.

### Project and thread authority

Scient’s project initialization owns only known missing files and fails closed
on symlinks/unsafe paths. The retired projectless conversation route is not
reintroduced by upstream merges. Current durable forks require a real project,
resolve message boundaries on the server, maintain immutable lineage, and
copy attachments/checkpoints/worktrees through a restart-safe saga.

The client may request a fork but cannot supply the authoritative boundary,
transcript count, checkpoint, or title authority. T3 thread creation and
navigation remain host seams; Scient owns the lineage/read-model/migration and
fork policy.

Evidence: `docs/internals/scient-project-initialization.md`,
`docs/internals/scient-fork-divergence.md`, PRs #9, #13, #19–#20, #99,
#118, #135, #146, and #159.

### Scientific data and rendering

Scient keeps local scientific data local and source-authored content canonical:

- Sources live under `.scient/sources` and PDFs are content-addressed;
- PDF/HTML/LaTeX/analysis representations have explicit artifact/revision
  identity and bounded retention;
- rich Markdown remains the message source, while Mermaid/Vega/Plotly/math/
  images are disposable local representations;
- local PDF/HTML/LaTeX state is validated against exact authority and current
  revision rather than expiring URLs;
- provider instructions advertise scientific capabilities only where delivery
  is verified.

The inherited host is reused through narrow seams: one ChatMarkdown renderer
branch or plugin array, file preview recognition/mounts, PDF asset transport,
browser preview leases, editor open methods, and RPC/client export points.
Scient does not fork the whole Markdown renderer, create a second source
database, or make a rich display representation authoritative.

### Cloud, telemetry, and mobile publication

Scient deliberately preserves local-first behavior and disables or gates paths
that could publish user data:

- first-party analytics is disabled by default and bounded;
- PDF/HTML/analysis/source data stays local unless an explicit feature contract
  says otherwise;
- T3 hosted preview, relay, cloud/OTA/mobile-store publication, and AUR
  workflows are not activated merely because upstream contains them;
- service code may exist as dormant/inert ancestry, but registration/onboarding
  remains disabled where the policy requires it.

## Upstream refresh history and decisions

The following is the integration narrative recorded in `UPSTREAM.md`, not a
claim that each T3 commit is Scient-authored.

| Refresh/checkpoint                  | Main decision                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-07 first refresh            | Adapted one public `T3 Code` heading to `Scient`; retained compatibility env names/attribution. Other T3 plan/chat/pagination/orchestration/connection/mobile/CI changes remained ordinary history.                                                                                             |
| 2026-08-07 second refresh           | Conflict-free; accepted T3 plan simplification, per-device settings, and mobile connection visibility without changing Scient-owned safety/identity.                                                                                                                                            |
| 2026-08-09 refreshes                | Conflict-free/limited; accepted T3 preview-focus, mobile settings, local transcript usage, archive/settle cleanup; did not inherit contributor-trust entries, live-data dev-DB copy, or hosted preview deployment.                                                                              |
| 2026-08-11 phase one                | Accepted v0.0.33 settings/accessibility/theme/mobile/security changes; combined SVG sandbox with Scient range/PDF seam; kept voice/dropped-file bridges; did not activate automatic mobile store/OTA or advisory fingerprint workflow.                                                          |
| through `f5fce741`                  | Accepted PR center and ordinary T3 history; retained General Chat file/PDF behavior, project-only PR/worktree guards, provider/release policy, and shared sidebar row. Owned merge `5fe83b7...` passed CI/manual macOS acceptance.                                                              |
| through `65b005f1`                  | Accepted Shift-click current-project creation and Copy Thread ID; resolved Sidebar conflict in favor of Scient’s General Chat multi-target distinction.                                                                                                                                         |
| through `ac4780f4`                  | Accepted T3 mobile composer/usage/version/typography corrections; retained disabled mobile publication and newer FFF dependency; corrected a focused typography characterization from 18 to 19.                                                                                                 |
| through `2db08457f`                 | Accepted theme/OKLCH/footer/git/path improvements; retained minimal stage branding, typography profile, sidebar identity.                                                                                                                                                                       |
| through `5015d7cf`                  | Accepted PR center/Open VSX/OAuth/mobile/layout changes; retained provider onboarding, identity, copy, projectless command subtitle, and Sources launcher adaptation.                                                                                                                           |
| through `97db94c9`                  | Accepted PR-panel viewport fix without changing a Scient-owned seam.                                                                                                                                                                                                                            |
| through `5304f3e9`                  | Accepted mobile/web/task-sheet/auto-settle improvements; retained trust-list/rebase policy, identity/stage art, and General Chat environment routing.                                                                                                                                           |
| through `7e01d33f`                  | Accepted browser-ready local discovery, favicons/tooltips/update guidance/asar changes; composed deeper T3 server probe with Scient relevant/other grouping and PDF canvas external/unpack authority.                                                                                           |
| through `8c628f14`                  | Accepted mobile/updater/remote-editor/terminal/git/titlebar changes; retained Scient identity, General Chat, provider/PDF/release paths; T3 AUR code remains inert ancestry.                                                                                                                    |
| through `6ae9662d8e`                | Conflict-free T3 dark-mode specificity fix; no Scient package changed.                                                                                                                                                                                                                          |
| through `bab4b6f02b`                | Accepted 98 T3 commits; 27 conflicts retained identity/state/release, Quick Chat/fork, generated/static artifacts, and disabled mobile publication. BiDi was kept independent of T3 `parseRawHtml`.                                                                                             |
| through `c7e6d711d3`                | Accepted tooltip/PR budget/browser/context/agent-browser updates; retained rich chat, projectless Quick Chat, static artifacts, multi-edge preview; browser access remains opt-in.                                                                                                              |
| through `f2d5fc91e3`                | Accepted lifecycle/browser/audio/PR/Clerk/service improvements; retained Quick Chat, Sources/PDF, provider lifecycle, identity, D4 service/release guards; dormant service registration stays disabled; Orchestration V2 not adopted.                                                           |
| through `beab6886f4`                | Accepted composer/tool activity/nav/PR/usage/OpenCode/file-refresh/updater changes; retained Quick Chat, queue/steer, voice, provider onboarding, Sources/PDF/BiDi/fork/sidebar/profile seams.                                                                                                  |
| through `be7d35aaeb`                | Accepted retry/clipboard/pin/stream/preview/UTF-8/CI work; composed parallel CI, PDF/range server asset, sidebar Quick Chat, trust-list reset, and retained docs/brand/release lanes. Dropped upstream `.plans/` content is recoverable from history.                                           |
| through `dedcd99a9d`                | Accepted background-thread/analytics/file-link/SSH/tailscale changes; retained fork gates, Scient migration numbering, steering, decoded workspace paths, and owner-set trust list.                                                                                                             |
| through `b1670ac7d9`                | Accepted workspace-image/recovery/appearance/provider/release improvements; retained release authority, fork serialization, browser-export RPC, and rich relative-workspace image card. Collapsed `ChatMarkdown` to one renderer with T3 generic classification plus Scient extra card actions. |
| through `e6a109b9f7` / `1a4a7596c2` | Accepted projection/lockfile/shortcut/signing/HEIC/Grok/migration-aware release work; retained immutable migrations, projections, scientific/rich surfaces, sidebar, release, and identity.                                                                                                     |
| through `99960383d0`                | Accepted update-banner/version/usage/Windows/file-link changes; retained workspace-relative preview and explicit HTML Browser route.                                                                                                                                                            |
| through `082e6ea521`                | Accepted PATH/reconnect/upgrade/unsigned-preview/dictation/rename/file-manager/Claude-compaction changes; extended recovery to Droid but deliberately reversed Claude compaction until after the next release.                                                                                  |

The partial `849bac894` record is preserved as historical evidence for the first
11 commits of that contiguous range. It is not a second live integration tip.

The historical `c7e6d711d3` row truthfully records that browser access remained
opt-in at that integration checkpoint. Scient PR #190 later changed the
server-authoritative default to on and coupled the same opt-out to project
Sources tools. Do not rewrite the older checkpoint as if the later product
decision had already existed.

## What was built and later removed, replaced, or deferred

### 1. General Chat → Quick Chat → retirement — removed

Lifecycle:

1. PR #35 introduced projectless General Chat.
2. PR #57 made its product boundary explicit and protected its workspace/
   routing behavior.
3. PR #103 renamed it Quick Chat.
4. PR #146 retired the surface and projectless threads.

PR #146 removed the projectless UI/modules under `apps/*/scient-quick-chat`,
`apps/web/src/scient/quickChat`, and the corresponding client-runtime state,
seam verifier, and projectless tests. It added the projectless-lineage cleanup
path/migrations (including migration 010 / `043_RetireProjectlessThreads` in
the recorded history), with attachment cleanup retried after the transactional
database step. Historical T3 #5822 commits remain only as frozen provenance.

The current product requires a real owning project. Historical event decoding
keeps only the nullability necessary to replay a thread that had already moved
into a project; no current command creates or relocates a projectless thread.

### 2. Client fork boundary → server-authoritative fork — replaced

The first fork prototype resolved completed-assistant boundaries in the client
and had a broader set of fork-specific persistence/UI files. Hardening moved
boundary resolution to SQL-backed server read models and made the client carry
only a selected message ID/title/workspace mode. The initial client boundary
files and `ScientForkUserMessageButton` were deleted; the old projection
boundary module was deleted; the authoritative resolver/lineage/saga replaced
them.

Prototype provenance is preserved in the fork document: prototype commit
`8ca683...`, archive branch `archive/claude-fork-prototype-20260808`, hardening
`a851...`, UI `29ea...`, and current T3 merge `13e33...`. This was an
architecture replacement, not loss of the user-visible fork outcome.

### 3. First voice prototype — reduced/hardened

Voice initially had live-preview, benchmark, capability-probe, and overlay
experiments. Hardening removed `overlayAnchor.ts`, `voiceBenchmark.ts`, the
capability-probe and live-preview modules/tests from the prototype line
(`176e928...`). Current voice is final local transcription with managed model
verification, cancellation, packaging, and optional provider-aware correction.

### 4. General provider action implementations → shared lifecycle host — replaced

Early provider-specific lifecycle action files and
`ProviderConnectionComposerAction.tsx` were replaced by shared
`ProviderConnectionActions`, `ProviderConnectionManager`,
`ProviderRuntimeManager`, and the lifecycle coordinator. The user-facing
actions survived; the duplicated per-provider UI/action host did not.

### 5. Fork-specific diff typography → shared tokens — replaced

The fork-specific diff typography implementation was removed in favor of a
small shared set of fixed Scient typography tokens. This kept the reading
profile stable through T3 appearance changes without scattering overrides over
inherited components.

### 6. Preview image surface store → static artifact/presentation model — replaced

An earlier `previewImageSurfaceStore` path was removed as the artifact and
presentation model became explicit. Static image/SVG/PNG remains supported;
the removed piece was the competing store/identity layer, not the visual
representation.

### 7. Unqualified single-dollar math recognition — rejected, then replaced

An early implementation recognized `$...$` too broadly and was removed. A
later guarded micromark tokenizer was retained after adversarial checks for
shell variables, prices, paths, interpolation, links, emphasis, and streaming
prefixes. The current implementation deliberately leaves ambiguous text
literal and uses KaTeX only after structural/lexical guards.

### 8. Prototype migration files → independent Scient migration ledger — replaced

The early fork prototype used an initial `038_ScientThreadLineage.ts` migration
that was removed during phase-B hardening. Scient now owns an independent
`scient_schema_migrations` ledger with contiguous-prefix/name validation,
preflight repair rules, and lifecycle guards. Old migration numbering is not
reused when T3 migrations arrive.

### 9. Scient Next visible identity → Scient — renamed, compatibility retained

The visible “Scient Next” identity and its test were replaced by the current
Scient product identity. The `scient-next` user-data location remains for
compatibility, and protocol/data namespaces are not casually rewritten. This
is a deliberate compatibility-preserving rename rather than a loss of data.

### 10. T3 Claude compaction — deliberately deferred, not Scient-built

The latest T3 sync contained Claude compaction. Scient retained it in literal
ancestry but applied a traceable deferral/reversal commit until after the next
release. This belongs in the report because it is a deliberate Scient/T3
integration decision, but it must not be misreported as a Scient feature or a
permanent deletion of T3 work.

### 11. Upstream `.plans/` tree — removed from checkout, recoverable

One T3 refresh removed upstream `.plans/` planning docs under the new work
artifact policy. Scient did not convert those docs into a feature; their
content remains recoverable from Git history. This is upstream housekeeping,
not a Scient capability retirement.

### 12. Closed release-note PR #110 — superseded

PR #110 was closed and replaced by #111/#112. The final LaTeX/release-note
content landed; #110 itself is not a shipped independent implementation.

## Current main versus integration-only or open work

| Work                                                  | Current status                    | Correct interpretation                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local MATLAB/analysis foundation (#70, #79, #87)      | current main                      | Bounded MATLAB contracts, complete first run/history/figure workflow, lifecycle, receipts, and result promotion.                                                                 |
| Completed MATLAB run/history/figure workflow (#79)    | current main                      | The first reusable MATLAB workflow is present in current `main`; broader stateful compute remains separate.                                                                      |
| Full stateful compute/Jupyter/extended session (#129) | integration-only/open             | Exists on the long-lived compute branch; do not call the session/Jupyter expansion current shipped main.                                                                         |
| Durable rich compute output (#158)                    | compute integration-only          | Representation bundles/display facts/Jupyter retention/resource checks merged into compute branch, not current main.                                                             |
| Manual Overleaf bidirectional sync (#121)             | open                              | Proposal branch/PR only; no current product sync.                                                                                                                                |
| Provider lifecycle child PRs (#153–#178)              | integrated via #150               | Built on the lifecycle branch, then landed through the parent integration PR; the program is current, but child base branches should not be mistaken for standalone main merges. |
| Managed runtime latest-update proposal (#179)         | open/docs only                    | No runtime/manifest/workflow/UI behavior; proposal only.                                                                                                                         |
| Analytics (#21–#24)                                   | current code, disabled by default | Runtime/contract exists; telemetry enablement is not implied.                                                                                                                    |
| Quick Chat/projectless threads (#35/#57/#103)         | retired                           | No current projectless creation/relocation path.                                                                                                                                 |

## Architecture pattern across the divergences

Scient repeatedly chooses the same boundary shape:

```text
T3 host / driver / editor / renderer
            |
     small marked seam
            |
Scient contract -> authoritative local/server state -> bounded UI/presenter
            |
       explicit receipt, test, and retirement condition
```

Examples:

- `ChatMarkdown.tsx` gets a narrow math/diagram/chart/image adapter instead of
  a second Markdown renderer;
- `FilePreviewPanel` and `openFile` remain the host while file classification,
  HTML/PDF/LaTeX surfaces and freshness stay in Scient modules;
- provider drivers remain T3-owned while lifecycle, managed runtime, auth
  proof, and awareness are Scient overlays;
- `thread.turn.start` remains the dispatch path while queue state is a separate
  pending-composer store;
- provider-neutral artifact/source identity is separated from each visual
  representation;
- local state is keyed by authoritative project/thread/document identity, not
  renewable URL or UI location.

The payoff is maintenance clarity: each divergence has an owner, a small
integration surface, a failure policy, tests, and—where appropriate—a deletion
or retirement condition.

## Open-source and external-source provenance

The repository’s `apps/web/THIRD_PARTY_NOTICES.md` and internal design records
were reviewed. The major Scient-owned additions use these sources:

| Source                                 | Use in Scient                            | Version/pinning and license/provenance                                                                                      |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T3 Code                                | host platform and ancestry               | official `pingdotgg/t3code`; exact Git ancestry, no squash/replay                                                           |
| PDF.js                                 | PDF reader and structural PDF validation | `pdfjs-dist` 6.2.108; locally bundled worker/maps/fonts/codecs                                                              |
| KaTeX + remark-math                    | local math rendering                     | KaTeX 0.16.47, remark-math 6.0.0; MIT notices, local fonts                                                                  |
| Mermaid                                | diagram rendering/export                 | Mermaid 11.16.1; MIT, locally bundled/lazy                                                                                  |
| Vega family                            | interactive chart rendering              | Vega 6.3.1, Vega-Lite 6.4.3, vega-embed 7.1.0, vega-tooltip 1.0.0; BSD 3-Clause                                             |
| Plotly + MathJax                       | interactive scientific charts/TeX labels | Plotly strict 3.7.0, MathJax 3.2.2; lazy local runtime                                                                      |
| Citation.js + citeproc + CSL           | source reference formatting              | Citation.js/plugin-csl 0.8.2, citeproc 2.4.63; Citation.js MIT, citeproc CPAL option, Vancouver/APA styles CC BY-SA 3.0     |
| `parse5`                               | bounded local-source HTML extraction     | pinned package in `scient-sources`                                                                                          |
| vscode-icons                           | custom file-icon symbols                 | selected symbols adapted in `src/pierre-icons.ts`; MIT notice                                                               |
| whisper.cpp                            | local voice inference                    | v1.9.1 commit `f049fff95a089aa9969deb009cdd4892b3e74916`; MIT; verified helper/archive receipts                             |
| SyncTeX standalone + zlib              | LaTeX forward/inverse navigation         | SyncTeX commit `82f46b64283b299b045a0295a09aadc11c644e1f`, CLI 1.7/parser 1.31; MIT helper, zlib 1.3.2 pinned               |
| TinyTeX/TeX Live                       | optional local LaTeX distribution        | TinyTeX `v2026.08` exact asset/digest; TinyTeX scripts GPL-2.0, TeX Live packages individually licensed, predominantly LPPL |
| OpenAI Codex                           | optional managed provider runtime        | unmodified official release; Apache-2.0 with upstream NOTICE/Ratatui notice                                                 |
| Zotero local API                       | read-only source intake                  | local API v3 at `127.0.0.1:23119`; no DB scan/cloud/credentials/writeback                                                   |
| NCBI E-utilities, Crossref, Europe PMC | exact DOI/PMID metadata enrichment       | public metadata endpoints; bounded exact identifiers; PDFs remain local                                                     |
| MATLAB                                 | local analysis execution                 | user-installed MATLAB R2026a verified locally; not bundled by Scient                                                        |

Other implementation dependencies such as Effect/Effect RPC/SQL/Atom, Vite
Plus, YAML, `tar`, `yauzl`, `jszip`, and browser APIs support the contracts;
they are not themselves Scient product capabilities. The project’s exact
dependency manifests should be treated as the current version authority.

## Final reconciliation

Scient is not simply “T3 with a new name.” Its durable, current-owned work is
the combination of product/release authority, project/thread policy, provider
lifecycle, local voice, skills, Sources/citations, scientific renderers,
file/PDF/HTML/LaTeX document surfaces, bounded analysis foundation, queue,
analytics policy, and the reliability/security gates around them.

At the same time, Scient is not a replacement for T3. The host runtime,
provider drivers, ordinary orchestration, editor/terminal foundations, and
many generic UI improvements remain upstream. The integration discipline is
the product: preserve literal ancestry, retain only deliberate divergences,
make every seam reviewable, and retire experiments completely when their
product premise is rejected.
