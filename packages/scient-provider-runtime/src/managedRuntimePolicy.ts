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
  // Codex 0.155 added the official voice runtime; newer Windows packages also
  // exceed the shared extraction entry limit. Keep prior installers readable
  // for publication tooling, while older app builds reject this policy safely.
  codex: { revision: 3, historicalRevisions: [1, 2] },
  claudeAgent: { revision: 1, historicalRevisions: [] },
  antigravity: { revision: 1, historicalRevisions: [] },
  antigravityAcp: { revision: 1, historicalRevisions: [] },
  cursor: { revision: 1, historicalRevisions: [] },
  droid: { revision: 1, historicalRevisions: [] },
  grok: { revision: 1, historicalRevisions: [] },
  pi: { revision: 1, historicalRevisions: [] },
  omp: { revision: 1, historicalRevisions: [] },
};
