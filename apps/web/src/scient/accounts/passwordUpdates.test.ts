import { AccountId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  toasts: [] as Array<{ title: string; actionProps?: { onClick: () => void } }>,
  undone: [] as unknown[],
  atom: undefined as unknown,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: (toast: (typeof state.toasts)[number]) => state.toasts.push(toast),
    close: () => undefined,
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (_registry: unknown, _command: unknown, args: unknown) => {
    state.undone.push(args);
    return Promise.resolve({
      _tag: "Success",
      value: { restored: 1, changed: 0, mirrorsLeft: ["Lab"] },
    });
  },
}));
vi.mock("./accountsState", async () => {
  const { Atom } = await import("effect/reactivity");
  state.atom = Atom.make<unknown>(undefined);
  return { accountsState: { snapshot: () => state.atom, undoPassword: "undo" } };
});

const { watchPasswordUpdates } = await import("./passwordUpdates");

const update = (undoId: string) => ({
  undoId,
  accountId: AccountId.make("acc_synthetic_lab"),
  name: "Lab",
  until: "2026-11-26T13:00:00.000Z",
});
const snapshot = (...undoIds: string[]) =>
  AsyncResult.success({ accounts: [], passwordUpdates: undoIds.map(update) });

it("tells each new password once, with an Undo for that update", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-primary");
  registry.set(atom, snapshot("waiting"));
  const stop = watchPasswordUpdates(registry, environmentId);
  // Waiting when this window first read Accounts: told then, not again.
  expect(state.toasts).toHaveLength(0);
  registry.set(atom, snapshot("waiting", "new"));
  registry.set(atom, snapshot("waiting", "new"));
  expect(state.toasts.map((toast) => toast.title)).toEqual(["Password updated"]);
  state.toasts[0]!.actionProps!.onClick();
  expect(state.undone).toEqual([{ environmentId, input: { undoId: "new" } }]);
  // A Keychain copy that kept the newer password is named.
  await vi.waitFor(() =>
    expect(state.toasts.map((toast) => toast.title)).toEqual([
      "Password updated",
      "Keychain or 1Password kept the newer password",
    ]),
  );
  stop();
});
