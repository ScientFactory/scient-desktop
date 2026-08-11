import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_GENERAL_CHAT_DEFAULT_EXPANDED,
  SCIENT_GENERAL_CHAT_EXPANDED_STORAGE_KEY,
  shouldRevealScientGeneralChat,
} from "./useScientGeneralChatDisclosure";

describe("Scient General Chat disclosure", () => {
  it("uses a Scient-owned persisted preference", () => {
    expect(SCIENT_GENERAL_CHAT_DEFAULT_EXPANDED).toBe(false);
    expect(SCIENT_GENERAL_CHAT_EXPANDED_STORAGE_KEY).toBe("scient:sidebar:general-chat-expanded");
  });

  it("reveals a General Chat when it becomes active without trapping the section open", () => {
    expect(shouldRevealScientGeneralChat({ previousActiveKey: null, activeKey: "thread-1" })).toBe(
      true,
    );
    expect(
      shouldRevealScientGeneralChat({ previousActiveKey: "thread-1", activeKey: "thread-1" }),
    ).toBe(false);
    expect(shouldRevealScientGeneralChat({ previousActiveKey: "thread-1", activeKey: null })).toBe(
      false,
    );
  });
});
