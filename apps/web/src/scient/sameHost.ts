import { Atom } from "effect/reactivity";

import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { hostEnvironmentIdAtom, primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { sameHostEnvironmentIds } from "./sameHostEnvironments";

const desktopManagedPrimary = () => {
  try {
    return readPrimaryEnvironmentTarget()?.source === "desktop-managed";
  } catch {
    return false;
  }
};

/** See `sameHostEnvironmentIds`; a browser's loopback is not the agent's. */
export const sameHostEnvironmentIdsAtom = Atom.make((get) =>
  sameHostEnvironmentIds({
    desktopApp: window.desktopBridge !== undefined,
    desktopManagedPrimary: desktopManagedPrimary(),
    primaryEnvironmentId: get(primaryEnvironmentIdAtom),
    hostEnvironmentId: get(hostEnvironmentIdAtom),
  }),
).pipe(Atom.withLabel("scient-same-host-environment-ids"));
