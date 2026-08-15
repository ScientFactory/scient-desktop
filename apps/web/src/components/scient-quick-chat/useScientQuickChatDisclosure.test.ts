import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_QUICK_CHAT_DEFAULT_EXPANDED,
  SCIENT_QUICK_CHAT_EXPANDED_STORAGE_KEY,
  shouldRevealScientQuickChat,
} from "./useScientQuickChatDisclosure";

describe("Scient Quick Chat disclosure", () => {
  it("uses a Scient-owned persisted preference", () => {
    expect(SCIENT_QUICK_CHAT_DEFAULT_EXPANDED).toBe(false);
    expect(SCIENT_QUICK_CHAT_EXPANDED_STORAGE_KEY).toBe("scient:sidebar:general-chat-expanded");
  });

  it("reveals a Quick Chat when it becomes active without trapping the section open", () => {
    expect(shouldRevealScientQuickChat({ previousActiveKey: null, activeKey: "thread-1" })).toBe(
      true,
    );
    expect(
      shouldRevealScientQuickChat({ previousActiveKey: "thread-1", activeKey: "thread-1" }),
    ).toBe(false);
    expect(shouldRevealScientQuickChat({ previousActiveKey: "thread-1", activeKey: null })).toBe(
      false,
    );
  });
});
