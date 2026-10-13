# Native file publication preparation PR brief

**Frozen pilot evidence:** source `1fb52333c0`, target main `84a7e2663b`. Read [current recommendations](CURRENT_RECOMMENDATIONS.md) first and recheck extraction against current main. Raw receipts and scratch patches remain local; no new implementation or hosted qualification is published here.

Proposed title: **feat(workspace): prepare native file publication without enabling it**.

Provide an independently testable publisher boundary from PR 353 while keeping current workspace saving intact. Add a separately invoked staging command and qualification CLI; retain the current exchange helper and its build command. Default server and desktop behavior stays on main's implementation until platform capability and client recovery work are qualified together.

## Source and target

Target pinned main `84a7e2663b30663da371555085cf7316086c041f`. Copy native inputs from PR 353 head `1fb52333c0ee31c50001acc5d0b198508bd3d959`. Preserve original contributor history on PR 353; do not import its merge commits into this PR.

The four native implementation/header files were last changed by Yaacov in `963488545e2d5098e8e3ba7137461a7dc231a70f`; the qualifier was last changed by Yaacov in `9b19753d73668d91803ee1e89bbda766da76173c`. These are mixed commits, so extract their owned changes rather than cherry-picking the entire commits. Preserve source authorship and record the PR/source-commit mapping. Attribute recomposed staging/docs work accurately; add co-authorship only for actual contributed work.

## Exact proposed scope

The eight-path preview (local evidence retained separately) adds the protocol/platform header, POSIX implementation, Windows implementation, protocol dispatcher and native qualifier; introduces `stage-file-publication.ts`; adds its explicit package command; and updates developer instructions. The five copied files are byte-identical to the source head. The stager omits the integration branch's deletion of the legacy binary.

Exclude the TypeScript publisher adapter, retained mutation/journal rewrite, WorkspaceFileSystem activation, new RPCs, server/bootstrap config, editor persistence changes, version/history UI, build/PDF fences and desktop/remote-server packaging activation. Keep main's `exchange.c`, original `stage-file-exchange.ts`, WSL payload fixes and all existing runtime code.

This is preparation, not shipped guarded saving. Windows and Linux capability refusals are represented honestly; adding this helper must not route existing saves into those refusals.

## Acceptance criteria

The branch diff contains only the accepted eight paths or explicit additional qualification wiring. The preview applies to the exact target main; existing runtime sources remain identical. Existing helper output and command remain usable after the new helper is staged, and the two binaries have distinct names.

Production and probe builds run only on their target hosts. Windows qualification initializes MSVC before invoking `cl.exe`. Run the maintained isolated qualifier on supported qualification hosts and document refused versus supported operations; require positive save/create support before later activation. Keep protocol version, ACL/private-retention, binding/relocation, cancellation/lease and capability results explicit.

Run applicable formatting/lint/types/tests/build, packaging/native checks where affected, and hosted CI/provenance on the exact new branch. Include meaningful regression coverage that staging does not delete the legacy binary; the local scratch pass already demonstrated this behavior, but it is not a maintained branch test. No policy waiver or export-ignore blanket is part of this scope.

## Evidence already available

The review-only candidate has 3,032 additions, no deletions and no runtime activation. Patch application, owned formatting, scoped lint, both macOS helper builds and native qualification pass. An actual legacy exchange succeeds after staging the new helper, with the legacy binary unchanged. See the [assessment](PUBLICATION_ASSESSMENT.md) for receipts, the broader main/head test comparison and qualification limits.

Linux/Windows/Intel Mac execution, clean-install branch checks and hosted CI are still required at their applicable scope. The current activated publication service is not merge-ready: Linux lacks required current-root authority, Windows lacks ordinary create/exchange, and client retained-attention handling is coupled to later persistence work.

Local Knip files/dependencies is not green: the preview and archived main produce the same two `infra/relay` development-dependency findings under consistent reused dependency links. Preserve that baseline evidence and complete clean-install branch qualification; no ignore-rule change is included.

## Coordination before execution

Confirm the accepted source/target pins, one owner for extraction, and a bounded ownership window for the native files and staging command. Continue unrelated work on PR 353; record any overlapping incoming commit instead of silently moving the extraction pin. After landing, reconcile main into the integration branch under its owner's control and account for the residual diff.

Documentation impact: **Updated** — `docs/operations/development.md`.

Assessment and scratch preview: **GPT-6.1-Sol through Scient's Codex harness**. Published here as a review brief; no implementation PR has been opened.
