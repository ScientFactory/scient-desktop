import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { accountsState } from "./accountsState";
import { handoffInstruction } from "./handoffInstruction";

export function watchAccountNotifications(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  present: (threadId: ThreadId, title: string, body: string) => void,
) {
  let seen = new Set<string>();
  return registry.subscribe(
    accountsState.snapshot({ environmentId, input: {} }),
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const next = new Set<string>();
      for (const entry of result.value.handoffs ?? []) {
        next.add(entry.handoffId);
        if (!seen.has(entry.handoffId))
          present(
            entry.threadId,
            `${entry.accountName}: ${handoffInstruction(entry)}${entry.kind === "push" && entry.number ? ` Tap ${entry.number}.` : ""}`,
            "Waiting for you",
          );
      }
      for (const entry of result.value.approvals) {
        next.add(entry.approvalId);
        if (!seen.has(entry.approvalId))
          present(
            entry.threadId,
            `${entry.targetName}: Approval needed`,
            "Allow this account use in Scient.",
          );
      }
      seen = next;
    },
    { immediate: true },
  );
}
