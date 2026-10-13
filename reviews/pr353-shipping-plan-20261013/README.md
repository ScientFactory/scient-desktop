# PR #353: extraction and first release review

Start with [current recommendations](CURRENT_RECOMMENDATIONS.md). This is the proposed sequence for extracting mergeable parts of [PR #353](https://github.com/ScientFactory/scient-desktop/pull/353), updated 13 October 2026.

- [Findings ownership and supersession](FINDINGS.md).
- [Canonical architecture review and 84 original finding IDs, plus U1–U4](ARCHITECTURE_REVIEW.md).
- [Helper-only first PR brief](FIRST_PR_BRIEF.md).
- [Completed publication pilot assessment](PUBLICATION_ASSESSMENT.md).
- [Current plan source comparison](current-plan-pin.json) and [catalogue reconciliation ledger](reconciliation.json).

The plan is pinned to PR head `5f6342e4688f16553caaaeddeeae85081336a3bc` and main `887e363db1eae11ca7d1566a48bd5c6c71d17f8f`. The catalogue is pinned to `b87625d49d`; the pilot is older, at `1fb52333c0` against main `84a7e2663b`. These scopes are distinct. Thirteen checked modules remain unchanged between the catalogue and plan heads; the newer reading/MathLive delta still needs its own qualification.

## Publication scope

This dedicated review branch shares the plans for discussion. It is not an implementation PR and is not intended to merge into product source. No feature is enabled, no integration-branch history is rewritten, and this publication does not claim new tests or release acceptance.

Current recommendations supersede the earlier PLAN.md; the 34-record legacy register is superseded by the canonical catalogue. Their historical originals, raw logs, scratch patches, inventories, HTML reports and local test fixtures remain outside this bundle. References to those receipts are explicitly marked as retained local evidence. Published source links use immutable Git revisions.

The documents are link-normalized shareable copies of the local review artifacts. Finding IDs, dispositions, uncertainty and source hashes are preserved. The JSON ledgers omit machine-local checkout paths; historical artifact hashes still describe their original local files.

The immediate proposal is inactive helper preparation, followed by an explicit platform decision, coherent publication/client activation and recovery correctness, extraction and qualification of implemented build/PDF and creation, bounded Visual enablement, then release acceptance. Contributor ownership and timing still need agreement. Publication of this plan authorizes neither implementation pushes nor merges.
