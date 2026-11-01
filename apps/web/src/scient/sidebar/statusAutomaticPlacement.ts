import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { planSidebarThreadDrop } from "../../components/Sidebar.logic";
import { manualOrderForPlacement } from "../sections/automaticPlacement";

export function statusPlacementKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function statusDropOrderReleased(input: {
  readonly presentationPending?: boolean;
  readonly membershipChanged?: boolean;
  readonly destinationKeys: readonly string[];
  readonly before: ReadonlyMap<string, string | null>;
  readonly assigned: ReadonlyMap<string, string>;
  readonly current: ReadonlyMap<string, string | null>;
}) {
  if (input.presentationPending) return false;
  const checked = new Set([...input.destinationKeys, ...input.assigned.keys()]);
  const superseded = [...checked].some((key) => {
    if (!input.current.has(key)) return true;
    const current = input.current.get(key) ?? null;
    return current !== (input.before.get(key) ?? null) && current !== input.assigned.get(key);
  });
  return (
    input.membershipChanged === true ||
    superseded ||
    [...input.assigned].every(([key, value]) => input.current.get(key) === value)
  );
}

export function planStatusThreadDrop(
  input: Parameters<typeof planSidebarThreadDrop>[0] & {
    readonly canonicalActiveOrder?: readonly string[] | undefined;
  },
): ReturnType<typeof planSidebarThreadDrop> {
  if (
    input.canonicalActiveOrder === undefined ||
    input.target.section !== "active" ||
    input.activeTimeOrdered
  )
    return planSidebarThreadDrop(input);
  const order = input.target.activeOrder;
  if (
    input.activeSection === "active" &&
    order.length === input.activeOrder.length &&
    order.every((key, index) => key === input.activeOrder[index])
  )
    return { kind: "none" };
  const plan = planSidebarThreadDrop({
    ...input,
    // A changed visual slot is a manual exception even when its saved key need not change.
    activeOrder: [],
    target: {
      ...input.target,
      activeOrder: manualOrderForPlacement(input.canonicalActiveOrder, order, input.activeKey),
    },
  });
  return plan.kind === "move-active"
    ? {
        ...plan,
        order,
        assignments: plan.assignments.filter(
          ({ id, orderKey }) => input.activeKeysById.get(id) !== orderKey,
        ),
      }
    : plan;
}
