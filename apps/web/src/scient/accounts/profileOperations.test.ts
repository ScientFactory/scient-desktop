import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ atom: undefined as unknown }));
vi.mock("./accountsState", async () => {
  const { Atom } = await import("effect/reactivity");
  state.atom = Atom.make<unknown>(undefined);
  return { accountsState: { snapshot: () => state.atom } };
});
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: () => "", close: () => {} } }));

const { appAtomRegistry } = await import("~/rpc/atomRegistry");
const { operationOutcome, operationTitle, settledOperation } = await import("./profileOperations");

const operation = (extra: object = {}) =>
  ({
    operationId: "op-copy",
    kind: "copy",
    profileId: "profile-lab",
    into: "profile-home",
    at: "2026-11-26T10:00:00.000Z",
    until: "2026-11-26T11:00:00.000Z",
    ...extra,
  }) as never;

it("tells the person only once the work has ended, and what part of it didn't", async () => {
  const atom = state.atom as Atom.Writable<unknown>;
  appAtomRegistry.set(atom, AsyncResult.success({ profileOperations: [] }));
  const told = settledOperation(
    EnvironmentId.make("env-local"),
    operation({ server: { state: "done" }, desktop: { state: "pending" } }),
  );
  let settled: unknown;
  void told.then((value) => (settled = value));
  await Promise.resolve();
  // Still copying on the desktop: nothing is said yet.
  expect(settled).toBeUndefined();
  appAtomRegistry.set(
    atom,
    AsyncResult.success({
      profileOperations: [
        operation({
          server: { state: "done" },
          desktop: { state: "done", uncovered: ["bank.example"] },
        }),
      ],
    }),
  );
  const ended = await told;
  expect(operationOutcome(ended!)).toMatchObject({ partly: true });
  expect(operationOutcome(operation({ server: { state: "failed" } }))).toMatchObject({
    partly: true,
  });
  expect(operationOutcome(operation({ server: { state: "done" } }))).toEqual({
    partly: false,
    description: undefined,
  });
});

it("says when a sign-out kept nothing for Undo, or couldn't reach a cookie (round 6d)", () => {
  // Linux without a keyring: the sign-out happened, with nothing to put back.
  expect(
    operationOutcome(
      operation({
        kind: "sign-out",
        site: "example.com",
        desktop: { state: "done", notRestorable: 3 },
      }),
    ),
  ).toEqual({ partly: true, description: "Undo can't put 3 cookies back on this computer" });
  expect(
    operationOutcome(
      operation({
        kind: "sign-out",
        site: "example.com",
        desktop: { state: "done", leftBehind: 1 },
      }),
    ),
  ).toEqual({ partly: true, description: "1 cookie couldn't be signed out" });
});

it("names an import's cause with the one thing to do, and counts the passwords (round 6d)", () => {
  const imported = (desktop: object) =>
    operation({ kind: "refresh", into: undefined, passwords: true, desktop });
  // regression: a locked browser or a refused read came back as a bare "Partly done".
  expect(operationOutcome(imported({ state: "failed", cause: "browserRunning" }))).toEqual({
    partly: true,
    description: "Quit the browser first so its cookie database can be read.",
  });
  expect(operationOutcome(imported({ state: "failed", cause: "passwordsNotSaved" }))).toEqual({
    partly: true,
    description: "The passwords were read but couldn't be saved. Try again.",
  });
  // A stopped import keeps what it brought in: it has no Undo or rollback (round 6n).
  expect(operationOutcome(imported({ state: "failed", cause: "stopped" }))).toEqual({
    partly: true,
    description:
      "The profile or agent access changed meanwhile, so it stopped. What it brought in stays.",
  });
  // A password-only import says how many it saved.
  expect(operationOutcome(imported({ state: "done", copied: 0, passwords: 4 }))).toEqual({
    partly: false,
    description: "4 passwords saved",
  });
});

it("counts every desktop's part of a sign-out, named, and titles it partial (round 6e)", () => {
  const signOut = operation({
    kind: "sign-out",
    into: undefined,
    site: "example.com",
    desktop: { state: "done", saved: 2 },
    others: [
      {
        computer: { id: "env-laptop", label: "Ada's laptop" },
        outcome: { state: "done", leftBehind: 1 },
      },
      {
        computer: { id: "env-desk", label: "Lab desk" },
        outcome: { state: "done", notRestorable: 2 },
      },
    ],
  });
  // regression: the other desktops' leftovers were left out, and it read "Signed out".
  expect(operationOutcome(signOut)).toEqual({
    partly: true,
    description:
      "1 cookie couldn't be signed out on Ada's laptop · Undo can't put 2 cookies back on Lab desk",
  });
  expect(operationTitle(signOut, { name: "Lab", into: "" })).toBe(
    "Partly signed out of example.com",
  );
  const failedThere = operation({
    kind: "sign-out",
    into: undefined,
    site: "example.com",
    desktop: { state: "done" },
    others: [
      { computer: { id: "env-laptop", label: "Ada's laptop" }, outcome: { state: "failed" } },
    ],
  });
  expect(operationOutcome(failedThere).description).toBe("Not done on Ada's laptop");
  expect(
    operationTitle(
      operation({
        kind: "sign-out",
        into: undefined,
        site: "example.com",
        desktop: { state: "done" },
      }),
      { name: "Lab", into: "" },
    ),
  ).toBe("Signed out of example.com");
});
