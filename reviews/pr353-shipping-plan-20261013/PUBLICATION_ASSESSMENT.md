# Publication pilot extraction assessment

**Frozen pilot evidence:** source `1fb52333c0`, target main `84a7e2663b`. Read [current recommendations](CURRENT_RECOMMENDATIONS.md) first and recheck extraction against current main. Raw receipts and scratch patches remain local; no new implementation or hosted qualification is published here.

The activated guarded-publication service is **not a clean first merge in its current form**. It changes ordinary saves across clients, depends on recovery/receipt handling from the persistence lane, and refuses required publication operations on Linux and Windows. The recommended first extraction is a narrower **native helper preparation PR with no service activation**. An eight-path review-only preview applies to pinned current main, builds on macOS, passes native qualification, and preserves the existing helper and runtime source.

The first pass is complete as an assessment and extraction preview. It does not establish public-release readiness, contributor agreement, or a fully qualified replacement PR.

## Pinned inputs

- PR 353: `1fb52333c0ee31c50001acc5d0b198508bd3d959`.
- Current main at discovery: `84a7e2663b30663da371555085cf7316086c041f`.
- PR's reported base/merge base: `67835830eb31b8d054680df654e94fee098cc69d`.
- Original product checkout: `9efc9e114865779118321a94b701b468de17b51e`; unrelated dirty changes were recorded and preserved.

The newer main includes Antigravity and WSL/payload fixes beyond the PR base. A merge-tree preview is clean, but copying complete feature files would undo some main-only WSL exclusions and tests. The pin receipt (local evidence retained separately), merge preview (local evidence retained separately), and source commit index (local evidence retained separately) preserve the exact comparison.

All test execution used archived sources and synthetic temporary fixtures. External dependencies came from an installed PR worktree; workspace package links resolve to the archived versions. These are local focused results with reused dependencies, not clean-install CI. Two harness setup failures were retained: missing root workspace links for direct staging, and missing lint-plugin dependencies in the dormant snapshot. After adding links only inside disposable snapshots, staging and scoped lint passed.

## Extraction decision

**Go to preparation of the inactive native helper PR. Do not activate the service or replace the existing publisher yet.**

The preview patch (local evidence retained separately) contains eight paths and 3,032 added lines, with no deletions:

1. `native/file-exchange/publication-platform.h`.
2. `native/file-exchange/publication-posix.c`.
3. `native/file-exchange/publication-windows.c`.
4. `native/file-exchange/publication.c`.
5. `native/file-exchange/qualify-publication.mjs`.
6. A new `scripts/stage-file-publication.ts`.
7. One additional build command in `package.json`.
8. Developer build/qualification instructions in `docs/operations/development.md`.

The first five files are exact copies from the pinned PR. The new staging script is recomposed from PR staging while omitting deletion of the legacy `scient-file-exchange` binary. The old staging command and `exchange.c` remain intact. No WorkspaceFileSystem, server configuration, RPC, save coordinator, renderer, default build chain or desktop packaging is activated by this preview. All pre-existing tracked source outside the two deliberate package/docs edits was checked against main; no unexpected changes were found.

This is an independently testable native contract and qualification tool, not the first user-visible feature shipment. Its capability refusals must stay explicit. It still needs target-host Linux/Windows qualification and the normal applicable branch gates before merge. If the project does not want a preparatory native PR, repair and qualify the activated publication/persistence boundary together before extracting it; do not copy the current service wholesale merely to start merging.

## Reviewed dependency boundary

The original 17-file directory bucket was not the complete pilot. The server/native/configuration/contract/packaging comparison spans **33 path records and 121 mechanical hunks**. Publication references reach another **40 changed consumer path records**. The resulting hunk index (local evidence retained separately) routes **578 hunks across 73 paths** to exact frozen patches. It is a routing index for mixed work, not a claim that every deferred consumer hunk has been independently qualified.

The actual dependency chain is:

Native protocol and OS primitives → process/binding adapter → durable retained mutation engine → workspace mutation service → WorkspaceFileSystem and configuration → RPC/error contracts and authorized clients → editor intent/checkpoint/recovery handling.

Overleaf consumes retained replace/remove semantics. Build/export consumers add settled reads, epochs and output fences. Desktop/remote-server packaging supplies the helper and its compiler environment. The dependency edges (local evidence retained separately) and semantic ranges (local evidence retained separately) describe these boundaries.

The largest mutation-service change is one hunk replacing hundreds of lines with roughly 2,500 lines. It includes canonical binding, journals/indexes, replay, write/create/rename/delete, optional pruning/history, explicit resolution and build fences. That hunk is not a sensible cherry-pick unit. The active extraction needs a semantic split and a minimal but complete recovery consumer.

The main persistence coordinator treats matching observed bytes as verification of a draft/attempt/baseline. The new transport carries mutation identity, retained-attention and explicit current review. An active server extraction cannot assume old clients understand those outcomes. This is source-level dependency evidence; a new production false-confirmation incident was not reproduced here.

## Integrity findings for the active lane

### P1 Linux and Windows availability

The source explicitly reports `strictCurrentRoot=false` on Linux in `publication-posix.c`, while `WorkspaceFileMutations.publish` requires it. Windows reports `atomicExchange=false` and `atomicCreateMetadata=false`, and its native operation dispatch refuses both exchange and create. Byte-publication admission then refuses changed writes and new-file creation; the supported same-byte no-op path does not make ordinary saving usable.

These are current source-confirmed activation blockers, not fresh Linux/Windows runtime measurements. The maintained qualifier can pass by proving refusal on unsupported operations. Future acceptance must include positive ordinary save/create behavior on every supported host, not just safe refusal tests. On macOS, creation also depends on the actual volume's clone capability; helper availability, retention on the source filesystem and storage admission remain explicit conditions.

Source owners: [POSIX capabilities](https://github.com/nattikahana/scient-desktop/blob/1fb52333c0ee31c50001acc5d0b198508bd3d959/native/file-exchange/publication-posix.c), [Windows capabilities/dispatch](https://github.com/nattikahana/scient-desktop/blob/1fb52333c0ee31c50001acc5d0b198508bd3d959/native/file-exchange/publication-windows.c), and [service admission](https://github.com/nattikahana/scient-desktop/blob/1fb52333c0ee31c50001acc5d0b198508bd3d959/apps/server/src/scient/workspace/WorkspaceFileMutations.ts). The [retained engine](https://github.com/nattikahana/scient-desktop/blob/1fb52333c0ee31c50001acc5d0b198508bd3d959/apps/server/src/scient/workspace/RetainedFileMutation.ts) has its own capability/refusal checks.

### P2 Recovery and retry closure

The active server returns unchanged versus retained-attention, durable intent IDs and review tokens. Client intent identity, decoder/transport handling, checkpoints and actionable review must land coherently. Keep failed or ambiguous outcomes blocked and preserve original intent and retained objects. History browsing conveniences can follow, but the only route out of a retained failure cannot be deferred.

### P3 Windows compiler setup

The pinned PR's Windows installer/native-runtime job fails with `spawnSync cl.exe ENOENT` in the new staging script. The corresponding pinned-main job succeeds. A fresh activation/packaging PR must establish the MSVC environment before the command that actually builds the helper. This is separate from the helper's deliberate refusal of unsupported Windows operations.

### P4 Existing main work and test coverage

The feature snapshot predates newer WSL exclusions for Windows canvas/keyring/Cursor packages. Carry only publisher packaging hunks onto current main. Preserve unrelated main metadata/read regressions while adapting write fixtures; the focused main/head suites have 78 main-only and 75 head-only test names, so their passing totals are not an equivalent coverage comparison.

### P5 Generic recovery fixture shape

Two head tests fail because decoded foreign checkpoints contain five additional null fields. Recorded diffs keep the foreign token, source bytes, revision and conflict flag unchanged. A disposable control compares the decoded foreign record before and after the actual rename/CAS operation; both cases pass. This supports an expectation-shape diagnosis for these failures, not blanket recovery qualification. Correct maintained expectations while retaining exact foreign ownership/content assertions and the rest of their workflow checks.

## Fresh checks and limits

The focused server/contracts/desktop group passes **197/197 on main** and **194/194 on the PR head**. It covers project schemas, authorization, backend helper selection, workspace filesystem/swap, retained mutation, and the head's cancellation/lease case. The changed test inventory is recorded in test-name-delta.json (local evidence retained separately).

The shared consumer group passes **76/76 on main** and **124/126 on the head**, with the two checkpoint-shape failures above. Session, persistence coordinator, RPC command, failure-reason and Markdown transport suites pass within this group. The original head consumer suite remains red; the two-case diagnostic does not turn it green.

Production/probe helper builds and the maintained native qualifier pass on macOS arm64 with **35 observations**. Cases include complete exclusive creation, retained actual entries and late descriptor writes, symlink/identity changes, compensation primitives, ACL/private-directory admission, relocation and cross-process lease ownership. Reported gaps include independent concurrent metadata changes, an actual unsupported clone volume, supported-volume/fsync/cross-volume/storage-full/power-loss coverage, and privileged wrong-owner qualification. This is bounded native evidence.

The inactive preview also passes patch application checking, owned-file formatting, scoped staging-script lint, production/probe compilation and its native qualification. Building the new helper leaves the legacy helper's SHA-256 unchanged, and an actual legacy A/B exchange still succeeds. Linux, Windows and Intel Mac execution, complete suites, typechecking/build/desktop smoke, hosted preview CI and release acceptance remain prospective gates. The copy-preserving preview has no runtime enablement to smoke-test, but its branch still needs the applicable repository gates.

A local Knip files/dependencies check remains red on the preview and archived main with identical output: two unused `infra/relay` development dependencies. An initial preview-only dependency-link layout also produced mobile-resolution noise; after giving each workspace its own snapshot links, that setup delta disappeared. This check is not claimed green, and the local result does not override pinned-main's successful hosted Check. The comparison receipt (local evidence retained separately) records the identical baseline; full clean-install qualification remains required. The preview also passes strict patch whitespace checking.

Receipts: focused runs (local evidence retained separately), consumer runs (local evidence retained separately), native run (local evidence retained separately), native observations (local evidence retained separately), preview build/legacy control (local evidence retained separately), preview checks (local evidence retained separately), successful scoped lint (local evidence retained separately), and diagnostic control (local evidence retained separately).

## Hosted baseline and provenance

Pinned-head Check fails on Knip's ten unused exports, including seven publication/retained-engine exports. Pinned-main Check succeeds. The active extraction must internalize/remove truly unused exports or establish real production use; broad exemptions would hide the problem.

Pinned-head provenance rejects **17 non-official merge parents** in the feature history. The latest pinned-main provenance attempt also rejects **two non-official merge parents** from its recent history; an earlier attempt on the same main SHA passed using a different verification base. This is base-sensitive provenance evidence, not a declaration that the gate is irrelevant. Submodule cleanup warnings appear later in both logs and are not the primary failure.

The proposed fresh native preparation PR introduces no feature merge parents. Preserve canonical ancestry and run the configured verifier with the actual new PR base/head. Do not cherry-pick the integration merge commits or weaken verification to import them.

Sources: [head Check](https://github.com/ScientFactory/scient-desktop/actions/runs/38279926933/job/114915244880), [head Windows packaging](https://github.com/ScientFactory/scient-desktop/actions/runs/38279926933/job/114918424425), [head provenance](https://github.com/ScientFactory/scient-desktop/actions/runs/38279926723/job/114914456381), [main Check](https://github.com/ScientFactory/scient-desktop/actions/runs/38282730078/job/114923661510), [main Windows packaging](https://github.com/ScientFactory/scient-desktop/actions/runs/38282730078/job/114924136090), and [latest main provenance](https://github.com/ScientFactory/scient-desktop/actions/runs/38282729752/job/114923659994). Local copies and check-run snapshots (local evidence retained separately) retain the observed state.

## Contributor coordination and next action

The [first-PR brief](FIRST_PR_BRIEF.md) is ready for review and sharing. Before extraction, agree ownership for the five native files and new staging command, pin the accepted source revision, and record how later incoming changes are reconciled. There is no active freeze or contributor agreement established by this pass.

Proceed with the inactive helper preparation if this boundary is accepted. Then resolve cross-platform publication and the client recovery contract before planning activation. Keep the original integration branch and other worktrees intact. No branch, commit, public PR, comment/message, merge setting, app lifecycle or live user profile was changed.
