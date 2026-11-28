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

vi.mock("./accountsState", () => ({
  accountsState: { snapshot: () => snapshot, pending: "pending-command" },
}));
/** Each answer a notice sent to the server. */
const answers = vi.hoisted(() => [] as unknown[]);
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const { AsyncResult: Result } = await import("effect/reactivity");
  return {
    ...(await importOriginal<object>()),
    runAtomCommand: async (_registry: unknown, _command: unknown, args: { input: unknown }) => {
      answers.push(args.input);
      return Result.success({});
    },
  };
});
const initial: AccountsSnapshot = {
  accountsProtocol: 2,
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

it("names the account, says what to do, and withdraws only the notice whose wait ended", async () => {
  sessionStorage.clear();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const notify = vi.fn();
  const withdraw = vi.fn();
  const environmentId = EnvironmentId.make("synthetic");
  const stop = watchAccountNotifications(registry, environmentId, notify, withdraw);
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
    expect(notify).toHaveBeenCalledWith({
      waitId: "synthetic-wait",
      threadId: handoff.threadId,
      title: "Synthetic",
      body: "Approve on your phone · 42",
    }),
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
    expect.objectContaining({ waitId: approval.approvalId, body: "Let the agent sign in?" }),
  );
  // A code found later is news under the same wait: presented again, with Insert; never digits.
  const code = { codeId: "c1", source: "messages" as const, at: handoff.startedAt };
  const withCode = { ...handoff, kind: "code" as const, codes: [code] };
  registry.set(
    snapshot,
    AsyncResult.success({ ...initial, handoffs: [withCode], approvals: [approval] }),
  );
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      waitId: "synthetic-wait",
      body: "A code arrived.",
      action: { label: "Insert code", run: expect.any(Function) },
    }),
  );
  // An older server can't take the click: the same news, with no Insert.
  registry.set(
    snapshot,
    AsyncResult.success({
      ...initial,
      accountsProtocol: 1,
      handoffs: [{ ...withCode, handoffId: "older-wait" }],
      approvals: [approval],
    }),
  );
  await vi.waitFor(() =>
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ waitId: "older-wait" })),
  );
  expect(notify.mock.lastCall?.[0]).not.toHaveProperty("action");
  registry.set(
    snapshot,
    AsyncResult.success({ ...initial, handoffs: [withCode], approvals: [approval] }),
  );
  // One code becoming several is news again, and no longer one tap.
  const several = { ...withCode, codes: [code, { ...code, codeId: "c2" }] };
  registry.set(
    snapshot,
    AsyncResult.success({ ...initial, handoffs: [several], approvals: [approval] }),
  );
  // Back on protocol 2 the wait is news again, then several codes once more.
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(6));
  expect(notify.mock.lastCall?.[0]).not.toHaveProperty("action");
  // The hand-off ends: its notice goes, the approval's stays.
  registry.set(snapshot, AsyncResult.success({ ...initial, approvals: [approval] }));
  await vi.waitFor(() => expect(withdraw).toHaveBeenCalledWith("synthetic-wait"));
  expect(withdraw).not.toHaveBeenCalledWith(approval.approvalId);
  // After a reload, what was announced isn't announced again.
  const again = vi.fn();
  const reloaded = watchAccountNotifications(registry, environmentId, again, vi.fn());
  reloaded();
  expect(again).not.toHaveBeenCalled();
});

it("tells the person again when the step they're asked for changes", async () => {
  sessionStorage.clear();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const notify = vi.fn();
  const stop = watchAccountNotifications(
    registry,
    EnvironmentId.make("synthetic"),
    notify,
    vi.fn(),
  );
  using _watch = { [Symbol.dispose]: stop };
  const push = {
    handoffId: "step-wait",
    threadId: ThreadId.make("synthetic-thread"),
    accountId: AccountId.make("acc_synthetic01"),
    accountName: "Synthetic",
    site: "example.com",
    kind: "push" as const,
    number: "42",
    startedAt: "2026-10-27T00:00:00Z",
    expiresAt: "2026-10-27T00:03:00Z",
  };
  const show = (handoff: typeof push | (Omit<typeof push, "kind" | "number"> & { kind: "code" })) =>
    registry.set(snapshot, AsyncResult.success({ ...initial, handoffs: [handoff] }));
  show(push);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  // A new number to tap, then the push turning into a code: each is said again.
  show({ ...push, number: "17" });
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  expect(notify.mock.lastCall?.[0]).toMatchObject({ body: "Approve on your phone · 17" });
  const { number: _number, ...rest } = push;
  show({ ...rest, kind: "code" });
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
});

it("carries the answer: Save to the suggested login, and It took it or It didn't", async () => {
  sessionStorage.clear();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const notify = vi.fn();
  const stop = watchAccountNotifications(
    registry,
    EnvironmentId.make("synthetic"),
    notify,
    vi.fn(),
  );
  using _watch = { [Symbol.dispose]: stop };
  const lab = {
    accountId: AccountId.make("acc_lab_ada001"),
    name: "Lab",
    updatedAt: "2026-11-26T10:00:00.000Z",
  } as AccountsSnapshot["accounts"][number];
  const held = {
    kind: "totp" as const,
    site: "https://lab.example.org",
    since: "2026-11-26T10:00:00.000Z",
  };
  registry.set(
    snapshot,
    AsyncResult.success({
      ...initial,
      accounts: [lab],
      pendingSecrets: [
        { ...held, pendingId: "key-1", accountId: lab.accountId },
        { ...held, pendingId: "password-1", kind: "password" as const, unclear: true as const },
        {
          ...held,
          pendingId: "password-2",
          kind: "password" as const,
          accountId: lab.accountId,
          conflict: true as const,
        },
      ],
    }),
  );
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
  const [key, unclear, conflict] = notify.mock.calls.map(([notice]) => notice);
  expect(
    [key, unclear, conflict].map(({ action, secondary }) => [action.label, secondary.label]),
  ).toEqual([
    ["Save to Lab", "Other…"],
    ["It took it", "It didn't"],
    ["Use this one", "Keep the saved one"],
  ]);
  // "Other…" opens Accounts; each answer goes to the server as the person saw the login.
  expect(key.secondary.run).toBeUndefined();
  for (const notice of [key, unclear, conflict]) {
    notice.action.run();
    notice.secondary.run?.();
  }
  await vi.waitFor(() => expect(answers).toHaveLength(5));
  expect(answers).toEqual([
    { type: "save", pendingId: "key-1", accountId: lab.accountId, updatedAt: lab.updatedAt },
    { type: "save", pendingId: "password-1" },
    { type: "discard", pendingId: "password-1" },
    { type: "save", pendingId: "password-2", replace: true, updatedAt: lab.updatedAt },
    { type: "discard", pendingId: "password-2" },
  ]);
});
