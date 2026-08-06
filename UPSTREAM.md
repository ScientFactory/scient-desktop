# Upstream maintenance

This is the private ScientFactory-owned T3-derived desktop candidate. Official
T3 supplies the maintained generic host platform; ScientFactory owns candidate
policy, identity, scientific behavior, release decisions, and every deliberate
divergence.

- Owned repository: `ScientFactory/scient-desktop-next`, default branch `main`
- Official upstream: `pingdotgg/t3code`, default branch `main`
- Writable remote: `origin`
- Fetch-only remote: `upstream`, push URL `DISABLED`
- Update mode: `thin-fork-merge`
- Machine state: [upstream-state.json](upstream-state.json)
- Bootstrap evidence: [Scient Next D4 bootstrap record](docs/internals/scient-next-d4-bootstrap.md)
- Authoritative migration policy: `Scient/docs/planning/t3-foundation-migration-plan.md`

The D4 integration base is
`a2ca89aa10f13a2222e08afd98c66285121d5ba2`, selected from freshly fetched
official `main` only after its untouched baseline passed. That revision is
literal ancestry of owned `main`; it is not merely a reviewed or observed tip.
Later observed T3 tips never move `integrationBase` by themselves.

## Receiving T3 updates

1. Refresh `origin`, the fetch-only `upstream`, open pull requests, branches,
   and worktrees before mutation.
2. Create a dedicated short-lived branch from the current owned `main`.
3. Merge one explicit official T3 range with its real Git history. Do not
   squash, replay, or manually rewrite ordinary upstream work.
4. Audit every protected divergence in the D4 bootstrap record: identity,
   state roots, protocols, preview partitions, telemetry/provider identity,
   OTLP, cloud/relay, service/updater/signing/publication, and workflow guards.
5. Resolve conflicts consciously and document any changed Scient-owned seam.
   Keep feature work out of the merge.
6. Run the repository-specific focused checks and complete non-visual suite,
   then use a reviewed draft pull request.
7. Advance `integrationBase` only when the exact upstream ancestry is actually
   present in owned history and the resulting owned head has passed its gate.

Synara is not a candidate remote. It remains a research donor and the
foundation of the separately supported continuity application. Valuable
Synara behavior must enter through a separately justified Scient-native lane,
never through a broad merge into this repository.

No upstream update authorizes public release, live cloud, mobile publication,
production credentials, or user-data conversion. Those remain separate Scient
gates even when inherited T3 code contains the capability.
