import type { ManagedRuntimeCatalogProvider } from "./managedRuntimeArtifact.ts";

/**
 * Bump installer compatibility only for the affected family so older apps retain compatible
 * runtimes. Historical revisions are publication inputs, never current releases without native
 * qualification.
 */
export const MANAGED_RUNTIME_POLICY: Readonly<
  Record<
    ManagedRuntimeCatalogProvider,
    { readonly revision: number; readonly historicalRevisions: ReadonlyArray<number> }
  >
> = {
  // Codex 0.166 unpacks past the 512 MiB older installers allow; keep their qualified
  // feeds readable but never advertise a package they would reject.
  codex: { revision: 5, historicalRevisions: [1, 2, 3, 4] },
  claudeAgent: { revision: 1, historicalRevisions: [] },
  antigravity: { revision: 1, historicalRevisions: [] },
  antigravityAcp: { revision: 2, historicalRevisions: [1] },
  cursor: { revision: 1, historicalRevisions: [] },
  droid: { revision: 1, historicalRevisions: [] },
  grok: { revision: 1, historicalRevisions: [] },
  pi: { revision: 1, historicalRevisions: [] },
  omp: { revision: 1, historicalRevisions: [] },
  scient: { revision: 1, historicalRevisions: [] },
  muse: { revision: 1, historicalRevisions: [] },
};
