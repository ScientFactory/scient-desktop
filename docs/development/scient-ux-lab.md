# Scient UX Lab

Status: maintained development experiment. It is not a product feature, release
surface, or backend-completeness claim.

The Scient UX Lab runs the real Scient web application: its router, project and
thread navigation, composer, settings, right panel, and production feature
components. It must not recreate those surfaces in a synthetic app shell.

The lab may replace a narrow external boundary with deterministic state when a
real service would make visual review slow, destructive, private, or difficult
to reproduce. Every replacement must be visibly identified as synthetic and
must call the same production UI component that the real application calls.

## Current journeys

### Zotero sources

The first journey uses the exact Scient Sources UI snapshot captured from:

- source branch: `feat/scient-sources-zotero-current-20260812`
- source head: `f2742c81b855faee7e2a81e91f0babfd508423d0`
- uncommitted snapshot fingerprint:
  `77c0e9950429a4ec863c904b4c0c4eaae44d7a23c7157006a9c74fc22f3e75a2`

Only the Zotero/source client responses are simulated. The active Zotero
implementation worktree is never read at runtime or modified by this lab.

Available scenarios are imported sources, a just-completed import, incomplete
metadata, and an empty source library. Open a project, add the real **Sources**
right-panel surface, and switch scenarios from the **UX Lab** control in the
app overlay. Drag either the collapsed button or the open card header away from
any surface under review; its position is retained across reloads. The card
automatically opens toward the available viewport space without restricting
where its button can be placed.

### MATLAB Run File

The MATLAB journey uses the exact production file editor, `.m` file seam, and
Run File panel integrated from `feat/matlab-run-foundation-20260812` at
`c7cb810315125da6d164c3cb3c3efe568122cb5b`. Only the external MATLAB process
is replaced, using the tracked synthetic runtime at
`apps/server/ux-lab-fixtures/matlab/fake-runtime/matlab`.

Choose a successful, failed, or long-running fixture from the **UX Lab**
control. The lab opens the real source file automatically. The production
analysis service still owns revision checks, execution receipts, streaming,
history, and cancellation. No MATLAB installation, license, credentials, or
private data are used.

## Launch

Run from this branch's isolated worktree:

```bash
mkdir -p "$PWD/.scient-next/ux-lab/userdata/analysis"
node -e 'const fs=require("node:fs");const path=require("node:path");const runtime=path.resolve("apps/server/ux-lab-fixtures/matlab/fake-runtime/matlab");fs.chmodSync(runtime,0o755);fs.writeFileSync(".scient-next/ux-lab/userdata/analysis/runtime-settings.json",JSON.stringify({version:1,executablePaths:{matlab:runtime}},null,2)+"\n")'

VITE_SCIENT_UX_LAB=1 \
T3CODE_PORT_OFFSET=531 \
pnpm run dev \
  --home-dir "$PWD/.scient-next/ux-lab" \
  --auto-bootstrap-project-from-cwd
```

Use the pairing URL printed by the runner. Do not reuse the stable Scient Dev
home, ports, or desktop process.

## Extension rules

1. Register a named journey and deterministic scenarios in
   `apps/web/src/scient/uxLab/`.
2. Keep production components unchanged unless the product implementation
   itself needs a reviewed change.
3. Intercept only the smallest external client/state boundary necessary for
   the scenario.
4. Label simulated state in the lab controls and documentation.
5. Never copy live credentials, private libraries, or user project data into a
   fixture.
6. Refresh the branch from current `origin/main` deliberately and revalidate
   each captured feature snapshot when its implementation changes.

The `VITE_SCIENT_UX_LAB` switch is disabled by default and must never be set in
release builds.
