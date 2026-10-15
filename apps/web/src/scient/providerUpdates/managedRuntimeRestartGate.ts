import type { EnvironmentId } from "@t3tools/contracts";

import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";
import { currentConfirmedServerTargets } from "~/components/sidebar/updateEverything.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

import {
  appProviderSnapshots,
  waitForManagedRuntimesIdle,
  type ReadServerProviders,
} from "./managedRuntimeUpdateWatch";

/**
 * The provider, server and install steps of an "update everything" pass, with
 * each restart held until no Scient-managed runtime update is running on that
 * machine, whoever started it. A machine Scient cannot confirm, because it
 * lost contact, is not restarted, and a notice says so.
 */
export function managedRuntimeGatedSteps(input: {
  readonly updateAll: (options: {
    readonly onWaitingChange?: (waiting: boolean) => void;
  }) => Promise<void>;
  readonly onWaitingChange: ((waiting: boolean) => void) | undefined;
  readonly readServerProviders: ReadServerProviders;
  /** The servers this pass confirmed. */
  readonly servers: ReadonlyArray<ServerUpdateTarget>;
  /** The servers eligible now; a pass can lose targets during its waits, never gain them. */
  readonly currentServers: () => ReadonlyArray<ServerUpdateTarget>;
  readonly updateServer: (server: ServerUpdateTarget) => Promise<unknown>;
  /** The environments this app hosts, which its install restarts. */
  readonly hostedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly installLocal: (() => Promise<void>) | undefined;
}) {
  const unconfirmed = (environmentIds: ReadonlyArray<EnvironmentId>) =>
    waitForManagedRuntimesIdle(appProviderSnapshots, environmentIds, input.readServerProviders);
  const installLocal = input.installLocal;
  return {
    updateProviders: () =>
      input.updateAll(input.onWaitingChange ? { onWaitingChange: input.onWaitingChange } : {}),
    updateServers: async () => {
      const gated = currentConfirmedServerTargets(input.servers, input.currentServers());
      // A server that dropped out because it disconnected is reported with the rest.
      const connected = new Set(
        appProviderSnapshots
          .read()
          .filter((environment) => environment.connection === "connected")
          .map((environment) => environment.environmentId),
      );
      const skipped = input.servers.filter(
        (server) =>
          !connected.has(server.environmentId) &&
          !gated.some((target) => target.environmentId === server.environmentId),
      );
      // Each server is checked just before its own restart, so a long wait on
      // one machine leaves no gap on another.
      await Promise.all(
        gated.map(async (server) => {
          if ((await unconfirmed([server.environmentId])).size > 0) {
            skipped.push(server);
            return;
          }
          const [current] = currentConfirmedServerTargets([server], input.currentServers());
          if (current) await input.updateServer(current);
        }),
      );
      if (skipped.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: `Did not update ${skipped.map((server) => server.serverLabel).join(", ")}`,
            description:
              "Scient lost contact, so it could not confirm that no Scient-managed provider update is still running there. Update once it reconnects.",
          }),
        );
      }
    },
    ...(installLocal
      ? {
          installLocal: async () => {
            if ((await unconfirmed(input.hostedEnvironmentIds)).size > 0) {
              toastManager.add(
                stackedThreadToast({
                  type: "warning",
                  title: "This app did not restart",
                  description:
                    "Scient lost contact with this computer's server, so it could not confirm that no Scient-managed provider update is still running. Restart to install the update once it reconnects.",
                }),
              );
              return;
            }
            await installLocal();
          },
        }
      : {}),
  };
}
