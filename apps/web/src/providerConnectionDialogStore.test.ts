import { beforeEach, describe, expect, it } from "vitest";

import { useProviderConnectionDialogStore } from "./providerConnectionDialogStore";

describe("provider connection dialog store", () => {
  beforeEach(() => {
    useProviderConnectionDialogStore.getState().setOpen(false);
    useProviderConnectionDialogStore.getState().clearConnectChain();
  });

  it("opens with provider and source context", () => {
    useProviderConnectionDialogStore.getState().openDialog("codex", "send");
    expect(useProviderConnectionDialogStore.getState()).toMatchObject({
      isOpen: true,
      provider: "codex",
      source: "send",
    });
  });

  it("replaces stale context when a second entry point opens", () => {
    useProviderConnectionDialogStore.getState().openDialog("codex", "provider_picker");
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "settings");
    expect(useProviderConnectionDialogStore.getState()).toMatchObject({
      isOpen: true,
      provider: "claudeAgent",
      source: "settings",
    });
  });

  it("clears context on close", () => {
    useProviderConnectionDialogStore.getState().openDialog("codex", "health_banner");
    useProviderConnectionDialogStore.getState().setOpen(false);
    expect(useProviderConnectionDialogStore.getState()).toMatchObject({
      isOpen: false,
      provider: null,
      source: null,
    });
  });

  it("keeps an active connect chain across dialog close", () => {
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "settings");
    const chain = useProviderConnectionDialogStore.getState().beginConnectChain("claudeAgent");
    useProviderConnectionDialogStore.getState().setOpen(false);
    expect(useProviderConnectionDialogStore.getState().connectChain).toEqual(chain);
  });

  it("only clears the connect chain for a matching token", () => {
    const chain = useProviderConnectionDialogStore.getState().beginConnectChain("antigravity");
    useProviderConnectionDialogStore.getState().clearConnectChain("some-other-token");
    expect(useProviderConnectionDialogStore.getState().connectChain).toEqual(chain);
    useProviderConnectionDialogStore.getState().clearConnectChain(chain.token);
    expect(useProviderConnectionDialogStore.getState().connectChain).toBeNull();
  });

  it("replaces a previous chain when a new one begins", () => {
    useProviderConnectionDialogStore.getState().beginConnectChain("codex");
    const next = useProviderConnectionDialogStore.getState().beginConnectChain("claudeAgent");
    expect(useProviderConnectionDialogStore.getState().connectChain).toEqual(next);
  });
});
