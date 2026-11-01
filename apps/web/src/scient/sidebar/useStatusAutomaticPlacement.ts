import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useDelegatedUnderParent } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { frozenPlacementEnvironmentsKeyAtom } from "../sections/loadedEnvironments";
import { sortByPlacement } from "../sections/automaticPlacement";
import { placementEligible } from "../sections/placementEligibility";
import { useAutomaticPlacement } from "../sections/useAutomaticPlacement";
import { automaticPlacementThreads } from "../sections/placementThreads";
import { statusPlacementKey } from "./statusAutomaticPlacement";

const GROUP_ID = "__status__";

export function useStatusAutomaticPlacement(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly openKey: string | null;
  readonly now: string;
  readonly visible: boolean;
  readonly workingShelfEnabled: boolean;
  readonly interacting: boolean;
  readonly optimisticOrder: readonly string[] | null;
}) {
  const frozenKey = useAtomValue(frozenPlacementEnvironmentsKeyAtom);
  const visits = useUiStateStore((state) => state.threadLastVisitedAtById);
  const delegatedUnderParent = useDelegatedUnderParent();
  const completeThreads = automaticPlacementThreads(
    input.threads,
    input.serverConfigs,
    input.now,
    delegatedUnderParent,
  );
  const rowFor = (thread: EnvironmentThreadShell) => {
    const key = statusPlacementKey(thread);
    return {
      key,
      orderKey: thread.activeOrderKey ?? null,
      eligible: placementEligible(thread, visits[key], input.now),
    };
  };
  const active = input.visible && !input.workingShelfEnabled;
  const placement = useAutomaticPlacement({
    scope: "status",
    groups: [{ id: GROUP_ID, rows: completeThreads.map(rowFor) }],
    openKey: input.openKey,
    ready: active && frozenKey !== null,
    paused: input.interacting,
    frozenEnvironmentIds: frozenKey ? frozenKey.split("\n") : [],
    knownKeys: input.threads.filter((thread) => thread.archivedAt === null).map(statusPlacementKey),
  });
  const enabled = placement.enabled && active;
  const order = placement.orders.get(GROUP_ID);
  const activeThreads =
    enabled && input.optimisticOrder === null && order !== undefined
      ? sortByPlacement(input.activeThreads, statusPlacementKey, order)
      : input.activeThreads;
  const onManualPlacement = useStableCallback(
    (key: string, order: readonly string[], orderKeys: ReadonlyMap<string, string>) => {
      if (!enabled) return;
      const moved = input.threads.find((thread) => statusPlacementKey(thread) === key);
      placement.onManualPlacement(
        GROUP_ID,
        order,
        key,
        orderKeys,
        moved === undefined ? undefined : rowFor(moved),
      );
    },
  );
  return {
    activeThreads,
    canonicalActiveOrder: enabled ? completeThreads.map(statusPlacementKey) : undefined,
    reorderableKeys: enabled
      ? new Set(
          input.threads
            .filter(
              (thread) =>
                input.serverConfigs.get(thread.environmentId)?.environment.capabilities
                  .threadActiveReorder === true,
            )
            .map(statusPlacementKey),
        )
      : undefined,
    onManualPlacement,
    onInteractionChange: placement.onInteractionChange,
  };
}
