import "../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { accountsState } from "./accountsState";

const state = vi.hoisted(() => ({
  protocol: 2,
  toasts: [] as Array<{
    type?: unknown;
    title?: unknown;
    description?: unknown;
    actionProps?: { onClick?: () => unknown };
  }>,
  operated: [] as unknown[],
  undone: [] as unknown[],
  answer: {} as unknown,
}));
vi.mock("~/components/ui/toast", async (original) => ({
  ...(await original<typeof import("~/components/ui/toast")>()),
  toastManager: {
    add: (toast: (typeof state.toasts)[number]) => {
      state.toasts.push(toast);
      return "synthetic-toast";
    },
    close: () => undefined,
    update: () => undefined,
  },
}));
vi.mock("./activityConversation", () => ({
  activityConversation: ({ threadId }: { threadId?: string }) =>
    threadId === "thread-lab" ? "Lab analysis" : undefined,
}));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: { accountsProtocol: state.protocol } }),
  useAccountCommand: (command: unknown) =>
    command === accountsState.operateProfile
      ? async (input: unknown) => {
          state.operated.push(input);
          return { ok: true, value: state.answer };
        }
      : async (input: unknown) => {
          state.undone.push(input);
          return {
            ok: true,
            value: { undone: { at: "2026-11-26T10:00:00.000Z", conflicts: ["GitHub"] } },
          };
        },
}));

const { useProfileOperations } = await import("./profileOperations");

function Harness() {
  const { run } = useProfileOperations(EnvironmentId.make("synthetic"));
  return (
    <>
      <button type="button" onClick={() => void run("clear", { id: "profile-lab", name: "Lab" })}>
        Clear Lab
      </button>
      <button
        type="button"
        onClick={() =>
          void run("copy", { id: "profile-lab", name: "Lab" }, undefined, {
            id: "profile-home",
            name: "Home",
          })
        }
      >
        Copy Lab to Home
      </button>
    </>
  );
}

it("clears at once with Undo, names the chats whose tabs stop a Remove, and says what Undo kept", async () => {
  state.answer = {
    operation: {
      operationId: "op-clear",
      kind: "clear",
      profileId: "profile-lab",
      at: "2026-11-26T09:00:00.000Z",
      until: "2026-11-26T10:00:00.000Z",
    },
  };
  await using _screen = await render(<Harness />, { router: false });
  await page.getByRole("button", { name: "Clear Lab" }).click();
  await vi.waitFor(() => expect(state.toasts.map(({ title }) => title)).toEqual(["Cleared Lab"]));
  // No confirmation: Undo in the notice; what was signed in since is named.
  await state.toasts[0]!.actionProps!.onClick!();
  expect(state.undone).toEqual([{ operationId: "op-clear" }]);
  expect(state.toasts.at(-1)?.title).toBe("Kept the sign-ins made since: GitHub");
  // Refused: nothing changes; the person is told which chats to close.
  state.toasts = [];
  state.answer = {
    refused: {
      reason: "open-tabs",
      message: "Close its tabs first.",
      threadIds: [ThreadId.make("thread-lab")],
    },
  };
  await page.getByRole("button", { name: "Clear Lab" }).click();
  await vi.waitFor(() =>
    expect(state.toasts).toEqual([
      expect.objectContaining({ title: "Close Lab's tabs first", description: "Lab analysis" }),
    ]),
  );
  // The menu's Copy to: the same operation, into the profile picked, with Undo.
  state.toasts = [];
  state.operated = [];
  state.answer = {
    operation: {
      operationId: "op-copy",
      kind: "copy",
      profileId: "profile-lab",
      into: "profile-home",
      at: "2026-11-26T09:00:00.000Z",
      until: "2026-11-26T10:00:00.000Z",
    },
  };
  await page.getByRole("button", { name: "Copy Lab to Home" }).click();
  await vi.waitFor(() =>
    expect(state.toasts.map(({ title }) => title)).toEqual(["Copied Lab to Home"]),
  );
  expect(state.operated).toEqual([
    expect.objectContaining({ kind: "copy", profileId: "profile-lab", into: "profile-home" }),
  ]);
});

it("says it is still being done, with no Undo, until every store has ended (round 6d)", async () => {
  await using _screen = await render(<Harness />);
  state.toasts = [];
  state.answer = {
    operation: {
      operationId: "op-pending",
      kind: "copy",
      profileId: "profile-lab",
      into: "profile-home",
      at: "2026-11-26T09:00:00.000Z",
      until: "2026-11-26T10:00:00.000Z",
      server: { state: "done", copied: 1 },
      desktop: { state: "pending" },
    },
  };
  await page.getByRole("button", { name: "Copy Lab to Home" }).click();
  // regression: after a minute it said "Copied" and offered Undo before the desktop had copied.
  await vi.waitFor(() =>
    expect(state.toasts).toEqual([{ type: "loading", title: "Copying Lab to Home…", timeout: 0 }]),
  );
});
