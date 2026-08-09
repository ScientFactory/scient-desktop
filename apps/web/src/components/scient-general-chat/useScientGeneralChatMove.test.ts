import { describe, expect, it } from "vite-plus/test";

import { isGeneralChatMoveWaitingForSessionStop } from "./useScientGeneralChatMove";

describe("isGeneralChatMoveWaitingForSessionStop", () => {
  it("recognizes the one transient relocation race", () => {
    expect(
      isGeneralChatMoveWaitingForSessionStop(
        new Error(
          "SCIENT_GENERAL_CHAT_MOVE_SESSION_STOP_PENDING: provider session must be stopped before relocation",
        ),
      ),
    ).toBe(true);
  });

  it("does not retry permanent invariant failures", () => {
    expect(
      isGeneralChatMoveWaitingForSessionStop(
        new Error("thread still has work in flight and cannot be relocated"),
      ),
    ).toBe(false);
  });
});
