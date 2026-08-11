import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_GENERAL_CHAT_LABEL,
  scientThreadAllowsCapability,
  supportsScientGeneralChat,
} from "./generalChat.js";

describe("Scient General Chat client policy", () => {
  it("requires the server to advertise projectless thread support", () => {
    expect(supportsScientGeneralChat({ projectlessThreads: true })).toBe(true);
    expect(supportsScientGeneralChat({ projectlessThreads: false })).toBe(false);
    expect(supportsScientGeneralChat(undefined)).toBe(false);
  });

  it("keeps the General Chat product label centralized", () => {
    expect(SCIENT_GENERAL_CHAT_LABEL).toBe("General chat");
  });

  it("applies restrictions only to General Chat and grants nothing without a thread", () => {
    expect(scientThreadAllowsCapability(null, "terminal")).toBe(true);
    expect(scientThreadAllowsCapability(null, "diff")).toBe(false);
    expect(scientThreadAllowsCapability("project-1", "diff")).toBe(true);
    expect(scientThreadAllowsCapability(undefined, "terminal")).toBe(false);
  });
});
