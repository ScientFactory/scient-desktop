# T3 upstream sync through 97db94c9

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Decision

Receive the largest clean contiguous prefix after the previous T3 integration
base. This adopts T3's pull-request-panel viewport containment fix and its
focused regression without changing a Scient-owned product seam.

The remaining official range is deliberately not cherry-picked around its
first overlapping commit. Preserving literal T3 ancestry means the next
alignment starts at `9513e62e` and consciously resolves the repository-local
trust-policy effect before it can receive the later latency and instruction
commits.

## Exact boundaries

- Owned base: `003fda087ecf4215b1c2ea83c64b26d498d4cac7`
- Previous literal T3 boundary:
  `5015d7cf9f98fe551115b625031f01e3f022cd2d`
- Integrated T3 target: `97db94c9bf6fa5d83f94c8fff85566d7fc96276e`
- Official tag at the target: `v0.0.34-nightly.20260813.1085`
- Integrated range: `5015d7cf..97db94c9`, one commit
- History-preserving merge: `033074db105109b9a4341ce9f9e6b2ffd70d106e`
- Integration branch: `agent/t3-sync-97db94c9-20260813`
- Inspection time: 2026-08-13 19:27 Asia/Jerusalem / 16:27 UTC
- Donor write boundary: the `upstream` push URL remains `DISABLED`

## Commit disposition

| Commit     | User effect                                                                                            | Quality                                                                            | Scient fit                                                                         | Disposition        |
| ---------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `97db94c9` | Keeps the pull-request panel within the viewport instead of allowing long content to escape its shell. | 5/5: a two-line layout correction with a focused regression for the exact failure. | Direct, low-risk fit in the inherited preview-panel seam; no Scient-owned overlap. | Adopted unchanged. |

## Remaining official range

The current official tip is `9e201941aaa9cfece3e0ffaa4cc24bbe880d1be4`.
The exact remainder is `97db94c9..9e201941`, three commits:

1. `9513e62e` changes T3's repository-local contributor trust list and overlaps
   Scient's independently governed trust file.
2. `2ab188f1` excludes pull-request actions from latency tracking. Its product
   patch is clean, but it follows the trust commit in official ancestry.
3. `9e201941` changes contributor instructions and overlaps Scient's governing
   `AGENTS.md` wrapper.

The first and third commits require conscious policy reconciliation. The middle
commit must not be cherry-picked ahead of them because doing so would replace a
normal upstream merge with selective replay.

## Verification

- Focused `PreviewPanelShell` regression
- Formatting check for the affected and evidence files
- Scient brand check
- `git diff --check`

Hosted CI remains the merge gate for the draft pull request.
