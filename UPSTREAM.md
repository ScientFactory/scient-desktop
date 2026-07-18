# Upstream maintenance

This is the ScientFactory-owned desktop application repository. Synara is a
read-only source of optional improvements; it does not control this product or
its release schedule.

- Owned branch: `ScientFactory/scient-desktop`, `main`
- Official reference: `Emanuele-web04/synara`, `main`
- Writable remote: `origin`
- Fetch-only remote: `upstream` with push URL `DISABLED`
- Machine review state: `upstream-state.json`
- Canonical policy: `Scient/docs/operations/upstream-intake.md`

Use `bun run scient:upstream-check` for topology, identity invariants,
divergence, and non-blocking review-state reporting in ordinary product CI. Use
`--require-reviewed-tip` when closing a disposition review; the strict mode
fails unless `reviewedThrough` equals the fetched official tip. Use `--intake`
from a clean maintenance branch to run the deterministic source suite before
proposing inherited code. `--review-check` remains a strict compatibility alias.

Being behind official Synara is not itself a failure. Unreviewed movement must
be surfaced, classified, and dispositioned. Upstream intake must not be mixed
with ordinary Scient product work. Preserve Scient identity, storage and
migration boundaries, credentials and session isolation, project-init
boundaries, permissions, and updater controls. Run a cross-repository Scient
agent smoke when a provider, protocol, runtime, or shared contract changes.
