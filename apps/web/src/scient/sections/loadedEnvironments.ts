import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";

/**
 * Environments whose thread list this client holds: a live shell snapshot.
 * A connected transport alone is not enough, since the snapshot loads after
 * it (and can fail to sync while the connection stays up). Joined into a
 * sorted key so consumers only re-render when the set changes.
 */
export const loadedThreadEnvironmentsKeyAtom = Atom.make((get): string => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const loaded: string[] = [];
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) loaded.push(environmentId);
  }
  return loaded.toSorted().join("\n");
}).pipe(Atom.withLabel("scient-sections-loaded-thread-environments"));
