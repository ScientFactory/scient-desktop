import type { ManagedRuntimeCatalogProvider } from "./managedRuntimeArtifact.ts";

/**
 * Compatibility between a release feed and the installer shipped in Scient.
 * Bump only the affected family when new releases require changed installer
 * policy. Older apps reject that revision and retain their compatible runtime.
 * Historical revisions are readable by publication tooling, never relabeled
 * or published as current without native qualification.
 */
export const MANAGED_RUNTIME_POLICY: Readonly<
  Record<
    ManagedRuntimeCatalogProvider,
    { readonly revision: number; readonly historicalRevisions: ReadonlyArray<number> }
  >
> = {
  // Codex 0.163 removed patched zsh. Older installers require it unconditionally;
  // keep their qualified feeds readable but never advertise the new layout to them.
  codex: { revision: 4, historicalRevisions: [1, 2, 3] },
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
