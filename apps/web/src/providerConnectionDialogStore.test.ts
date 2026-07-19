import { beforeEach, describe, expect, it } from "vitest";

import { useProviderConnectionDialogStore } from "./providerConnectionDialogStore";

describe("provider connection dialog store", () => {
  beforeEach(() => {
    useProviderConnectionDialogStore.getState().setOpen(false);
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
});
