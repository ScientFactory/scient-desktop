/** SCIENT-OWNED. Settings > Storage already offers to reclaim freed database space, but few
 * people look there. This reminds once per environment, until dismissed, when a database
 * holds at least the recommended amount of freed space, and leads to that existing control. */
import { databaseReclaimMinutes, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { toastManager } from "../../components/ui/toast";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSummaries } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";

const reclaimableEnvironmentsAtom = Atom.make((get) => {
  const identities = get(environmentSummaries.identitiesAtom);
  const key = JSON.stringify(identities.map((identity) => identity.environmentId));
  return get(serverEnvironment.databaseCompactionRecommendations(key)).map((recommendation) => ({
    ...recommendation,
    label:
      identities.find((identity) => identity.environmentId === recommendation.environmentId)
        ?.label ?? recommendation.environmentId,
  }));
}).pipe(Atom.withLabel("web-database-storage-reminders"));

const dismissalKey = (environmentId: EnvironmentId) =>
  `scient:database-storage-reminder:v1:${environmentId}`;

const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function startDatabaseStorageReminders(router: AnyRouter): () => void {
  const shown = new Set<EnvironmentId>();
  return appAtomRegistry.subscribe(
    reclaimableEnvironmentsAtom,
    (environments) => {
      for (const { environmentId, label, status } of environments) {
        if (shown.has(environmentId)) continue;
        try {
          if (getLocalStorageItem(dismissalKey(environmentId), Schema.Boolean)) continue;
        } catch {}
        shown.add(environmentId);
        const persistDismissal = () => {
          try {
            setLocalStorageItem(dismissalKey(environmentId), true, Schema.Boolean);
          } catch {}
        };
        const dismiss = () => {
          persistDismissal();
          toastManager.close(id);
        };
        const minutes = databaseReclaimMinutes(status);
        const id = toastManager.add({
          title: `Scient can free ${formatGiB(status.reclaimableBytes)} on ${label}`,
          description: `Cleaned-up history left unused space in its database. Reclaiming it restarts Scient, which is unavailable for about ${minutes} ${minutes === 1 ? "minute" : "minutes"}. You choose when.`,
          timeout: 0,
          onClose: persistDismissal,
          actionProps: {
            children: "Open Storage",
            onClick: () => {
              dismiss();
              void router.navigate({ to: "/settings/storage" });
            },
          },
          data: {
            actionLayout: "stacked-end",
            secondaryActionProps: { children: "Not now", onClick: dismiss },
            secondaryActionVariant: "ghost",
          },
        });
      }
    },
    { immediate: true },
  );
}
