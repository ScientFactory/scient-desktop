import type { NativeApi } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  providerSignOutConfirmationMessage,
  requestProviderSignOut,
} from "./providerSignOutRequest";

function api(confirm: boolean) {
  const dialogs = { confirm: vi.fn().mockResolvedValue(confirm) };
  const server = {
    signOutProvider: vi.fn().mockResolvedValue({ providers: [] }),
  };
  return {
    value: { dialogs, server } as unknown as Pick<NativeApi, "dialogs" | "server">,
    dialogs,
    server,
  };
}

describe("requestProviderSignOut", () => {
  it("uses the native confirmation and does nothing when the user cancels", async () => {
    const fixture = api(false);
    await expect(requestProviderSignOut(fixture.value, "codex")).resolves.toBeNull();
    expect(fixture.dialogs.confirm).toHaveBeenCalledOnce();
    expect(fixture.server.signOutProvider).not.toHaveBeenCalled();
  });

  it("calls the exact provider once after confirmation", async () => {
    const fixture = api(true);
    await requestProviderSignOut(fixture.value, "claudeAgent");
    expect(fixture.server.signOutProvider).toHaveBeenCalledOnce();
    expect(fixture.server.signOutProvider).toHaveBeenCalledWith({ provider: "claudeAgent" });
  });

  it("states that provider CLI credentials outside Scient may also be signed out", () => {
    const message = providerSignOutConfirmationMessage("cursor");
    expect(message).toContain("official CLI sign-out command");
    expect(message).toContain("terminals and other apps");
  });
});
