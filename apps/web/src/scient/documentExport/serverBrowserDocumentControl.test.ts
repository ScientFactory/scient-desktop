import { describe, expect, it } from "vite-plus/test";
import {
  readServerBrowserDocumentControl,
  updateServerBrowserDocumentControl,
} from "./serverBrowserDocumentControl";

describe("linked document navigation control bridge", () => {
  it("retains only the current owning viewer lease and clears it on ownership loss/disconnect", () => {
    const mount = Symbol();
    const tab = "remote-control-test";
    updateServerBrowserDocumentControl(tab, mount, {
      canOperate: true,
      controller: "you",
      generation: 4,
      controllingViewerId: "viewer-secret",
      dialog: null,
    });
    expect(readServerBrowserDocumentControl(tab)).toEqual({
      controllingViewerId: "viewer-secret",
      expectedControlGeneration: 4,
    });
    updateServerBrowserDocumentControl(tab, mount, {
      canOperate: true,
      controller: "another-viewer",
      generation: 5,
      dialog: null,
    });
    expect(readServerBrowserDocumentControl(tab)).toBeNull();
    updateServerBrowserDocumentControl(tab, mount, {
      canOperate: true,
      controller: "you",
      generation: 6,
      controllingViewerId: "viewer-secret",
      dialog: null,
    });
    updateServerBrowserDocumentControl(tab, mount, null);
    expect(readServerBrowserDocumentControl(tab)).toBeNull();
  });
  it("never treats an agent/read-only/old-server viewer as the current human controller", () => {
    const mount = Symbol();
    const tab = "remote-control-denied";
    for (const control of [
      {
        canOperate: false,
        controller: "you" as const,
        generation: 1,
        controllingViewerId: "viewer-secret",
        dialog: null,
      },
      {
        canOperate: true,
        controller: "agent" as const,
        generation: 1,
        controllingViewerId: "viewer-secret",
        dialog: null,
      },
      { canOperate: true, controller: "you" as const, generation: 1, dialog: null },
    ]) {
      updateServerBrowserDocumentControl(tab, mount, control);
      expect(readServerBrowserDocumentControl(tab)).toBeNull();
    }
  });
});
