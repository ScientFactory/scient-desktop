import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

// SCIENT-FORK:START — guest links need T3 Connect, which Scient keeps off.
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
// SCIENT-FORK:END
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";

/**
 * Whether this environment offers "Share with guest": the user may create links there, and its
 * Guest links beta is on (Settings > Beta). The server refuses links while the beta is off.
 */
export const canShareWithGuestAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      // SCIENT-FORK:START — guest links need T3 Connect, which Scient keeps off.
      hasCloudPublicConfig() &&
      // SCIENT-FORK:END
      get(serverEnvironment.createGuestShare.permissionAtom(environmentId)) &&
      get(environmentPresentations.serverConfigsAtom).get(environmentId)?.settings
        .guestSharingEnabled === true,
  ).pipe(Atom.withLabel(`guest-share:available:${environmentId}`)),
);
