import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { allReachableShellsLiveAtom, expectsPrimaryEnvironment } from "../../state/shell";

/**
 * Whether every environment that could hold a saved draft's project has said what it holds,
 * so a project still missing is gone. A ready, empty catalog is settled only when no primary
 * environment is on its way: hosted, or a desktop without its local environment, after the last
 * pairing was removed.
 */
export function draftEnvironmentsSettled(input: {
  readonly catalog: EnvironmentCatalogState;
  readonly reachableShellsLive: boolean;
  readonly expectsPrimary: boolean;
}): boolean {
  if (input.reachableShellsLive) return true;
  return input.catalog.isReady && input.catalog.entries.size === 0 && !input.expectsPrimary;
}

export const draftEnvironmentsSettledAtom = Atom.make((get) =>
  draftEnvironmentsSettled({
    catalog: get(environmentCatalog.catalogValueAtom),
    reachableShellsLive: get(allReachableShellsLiveAtom),
    expectsPrimary: expectsPrimaryEnvironment(),
  }),
).pipe(Atom.withLabel("scient-draft-environments-settled"));
