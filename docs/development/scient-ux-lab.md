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

## Current journey: Zotero sources

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

## Launch

Run from this branch's isolated worktree:

```bash
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
