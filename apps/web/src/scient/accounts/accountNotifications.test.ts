import { expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import {
  AccountApprovalId,
  AccountId,
  EnvironmentId,
  ThreadId,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { watchAccountNotifications } from "./accountNotifications";

vi.mock("./accountsState", () => ({ accountsState: { snapshot: () => snapshot } }));
const initial: AccountsSnapshot = {
  agentAccess: true,
  accounts: [],
  profiles: [],
  approvals: [],
  handoffs: [],
  recentActivity: [],
  customModelKeys: [],
  stores: {
    scient: { protection: "file" },
    keychain: { available: false, platform: "linux" },
    onePassword: { state: "not-connected" },
  },
};
const snapshot = Atom.make(AsyncResult.success(initial));

it("notifies once per wait or approval, preserving thread identity across updates", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const notify = vi.fn();
  const stop = watchAccountNotifications(registry, EnvironmentId.make("synthetic"), notify);
  using _watch = { [Symbol.dispose]: stop };
  const handoff = {
    handoffId: "synthetic-wait",
    threadId: ThreadId.make("synthetic-thread"),
    accountId: AccountId.make("acc_synthetic01"),
    accountName: "Synthetic",
    site: "example.com",
    kind: "push" as const,
    number: "42",
    startedAt: "2026-10-27T00:00:00Z",
    expiresAt: "2026-10-27T00:03:00Z",
  };
  registry.set(snapshot, AsyncResult.success({ ...initial, handoffs: [handoff] }));
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      handoff.threadId,
      "Synthetic: Approve the sign-in on your phone. Tap 42.",
      "Waiting for you",
    ),
  );
  registry.set(
    snapshot,
    AsyncResult.success({ ...initial, handoffs: [{ ...handoff, kind: "captcha" }] }),
  );
  const approval = {
    approvalId: AccountApprovalId.make("apr_synthetic01"),
    threadId: handoff.threadId,
    target: { type: "account" as const, accountId: handoff.accountId },
    targetName: "Synthetic",
    action: "sign-in" as const,
    requestedAt: handoff.startedAt,
    expiresAt: handoff.expiresAt,
  };
  registry.set(
    snapshot,
    AsyncResult.success({ ...initial, handoffs: [handoff], approvals: [approval] }),
  );
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  expect(notify).toHaveBeenLastCalledWith(
    handoff.threadId,
    "Synthetic: Approval needed",
    "Allow this account use in Scient.",
  );
});
