import { describe, expect, it } from "vite-plus/test";

import { resolveScientGeneralChatMovePlacement } from "./movePlacement";

describe("General Chat move placement", () => {
  it("keeps the header action and adds a second panel action while open", () => {
    expect(
      resolveScientGeneralChatMovePlacement({
        isGeneralChat: true,
        isServerThread: true,
        rightPanelOpen: false,
      }),
    ).toEqual({ header: true, panel: false });
    expect(
      resolveScientGeneralChatMovePlacement({
        isGeneralChat: true,
        isServerThread: true,
        rightPanelOpen: true,
      }),
    ).toEqual({ header: true, panel: true });
  });

  it("does not mount General Chat move actions for drafts or project threads", () => {
    expect(
      resolveScientGeneralChatMovePlacement({
        isGeneralChat: true,
        isServerThread: false,
        rightPanelOpen: true,
      }),
    ).toEqual({ header: false, panel: false });
    expect(
      resolveScientGeneralChatMovePlacement({
        isGeneralChat: false,
        isServerThread: true,
        rightPanelOpen: true,
      }),
    ).toEqual({ header: false, panel: false });
  });
});
