# Current Visual LaTeX findings owner

Use the [current 84-ID architecture review](ARCHITECTURE_REVIEW.md) and its [reconciliation ledger](reconciliation.json) as the single current findings catalogue. That review reconciles original IDs at `b87625d49d535d9afd3a3319d5e1f1258d7b23db` and adds U1–U4 for current blockers and qualification. Implemented does not mean freshly qualified on every platform.

The earlier 34-record register is preserved verbatim as historical evidence (local evidence retained separately). It is superseded for scheduling and closure decisions. Do not maintain a second independent set of R01–R34 statuses. Reconcile any historical trigger not covered by a canonical ID with that catalogue's owner rather than discarding it or inventing a competing status.

The [current recommendations](CURRENT_RECOMMENDATIONS.md) are pinned to PR `5f6342e4688f16553caaaeddeeae85081336a3bc` and main `887e363db1eae11ca7d1566a48bd5c6c71d17f8f`. The [source comparison](current-plan-pin.json) verifies 13 relevant publication, recovery, rename, build, SyncTeX and language modules unchanged from the catalogue head. The subsequent reading/MathLive delta has not been independently qualified by this comparison.

The [publication pilot assessment](PUBLICATION_ASSESSMENT.md) remains frozen evidence at `1fb52333c0` against main `84a7e2663b`. Recheck its preview against accepted current main before extracting. Its active-publication evidence supplements A01–A03/U1/U3; pipeline evidence supplements U2; recovery/consumer evidence supplements Q01/U3 and the R/SP group. These are evidence cross-references, not automatic closure of related scenarios.
