import { describe, expect, it } from "vite-plus/test";

import { resolveScientQuickChatMovePlacement } from "./movePlacement";

describe("Quick Chat move placement", () => {
  it("keeps the header action and adds a second panel action while open", () => {
    expect(
      resolveScientQuickChatMovePlacement({
        isQuickChat: true,
        isServerThread: true,
        rightPanelOpen: false,
      }),
    ).toEqual({ header: true, panel: false });
    expect(
      resolveScientQuickChatMovePlacement({
        isQuickChat: true,
        isServerThread: true,
        rightPanelOpen: true,
      }),
    ).toEqual({ header: true, panel: true });
  });

  it("does not mount Quick Chat move actions for drafts or project threads", () => {
    expect(
      resolveScientQuickChatMovePlacement({
        isQuickChat: true,
        isServerThread: false,
        rightPanelOpen: true,
      }),
    ).toEqual({ header: false, panel: false });
    expect(
      resolveScientQuickChatMovePlacement({
        isQuickChat: false,
        isServerThread: true,
        rightPanelOpen: true,
      }),
    ).toEqual({ header: false, panel: false });
  });
});
