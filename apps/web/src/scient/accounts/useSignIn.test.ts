import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AccountId, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";
import { useSignIn } from "./useSignIn";

const thread = {
  environmentId: "local" as EnvironmentId,
  threadId: "scratch-1" as ScopedThreadRef["threadId"],
};
const command = vi.fn();

vi.mock("./useAccounts", () => ({
  useAccountCommand: () => command,
  useAccounts: () => ({ data: { accountsProtocol: 1 } }),
}));
vi.mock("./useScratchThread", () => ({ useScratchThread: () => async () => thread }));

const surfaces = () =>
  (useRightPanelStore.getState().byThreadKey[scopedThreadKey(thread)]?.surfaces ?? []).map(
    (surface) => surface.id,
  );

beforeEach(() => {
  command.mockReset();
  useRightPanelStore.setState({ byThreadKey: {}, pendingMaximizeThreadKey: null });
});

it("opens a new conversation onto its browser before the sign-in tab is ready", async () => {
  let shownWhileStarting: string[] = [];
  command.mockImplementation(async () => {
    shownWhileStarting = surfaces();
    return { ok: true, value: { tabId: "tab-1" } };
  });
  expect(await useSignIn(thread.environmentId)("account-1" as AccountId)).toBe(true);
  expect(shownWhileStarting).toEqual(["browser:new"]);
  expect(surfaces()).toEqual(["browser:tab-1"]);
});

it("takes the waiting browser away when the sign-in can't start", async () => {
  command.mockResolvedValue({ ok: false });
  expect(await useSignIn(thread.environmentId)("account-1" as AccountId)).toBe(false);
  expect(surfaces()).toEqual([]);
});
