import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_QUICK_CHAT_LABEL,
  SCIENT_QUICK_CHAT_LEGACY_SEARCH_TERMS,
  SCIENT_QUICK_CHATS_LABEL,
  scientThreadAllowsCapability,
  supportsScientQuickChat,
} from "./quickChat.js";

describe("Scient Quick Chat client policy", () => {
  it("requires the server to advertise projectless thread support", () => {
    expect(supportsScientQuickChat({ projectlessThreads: true })).toBe(true);
    expect(supportsScientQuickChat({ projectlessThreads: false })).toBe(false);
    expect(supportsScientQuickChat(undefined)).toBe(false);
  });

  it("keeps the Quick Chat product label centralized", () => {
    expect(SCIENT_QUICK_CHAT_LABEL).toBe("Quick chat");
    expect(SCIENT_QUICK_CHATS_LABEL).toBe("Quick chats");
    expect(SCIENT_QUICK_CHAT_LEGACY_SEARCH_TERMS).toEqual(["general chat"]);
  });

  it("applies restrictions only to Quick Chat and grants nothing without a thread", () => {
    expect(scientThreadAllowsCapability(null, "terminal")).toBe(true);
    expect(scientThreadAllowsCapability(null, "diff")).toBe(false);
    expect(scientThreadAllowsCapability("project-1", "diff")).toBe(true);
    expect(scientThreadAllowsCapability(undefined, "terminal")).toBe(false);
  });
});
