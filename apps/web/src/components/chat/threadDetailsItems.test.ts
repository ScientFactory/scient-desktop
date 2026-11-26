import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;
const contextWindow = THREAD_DETAILS_ITEMS.find((item) => item.id === "contextWindow")!;

describe("thread details items", () => {
  it.each([
    { legacy: false, items: {}, usage: false, contextWindow: true },
    { legacy: true, items: {}, usage: true, contextWindow: true },
    { legacy: true, items: { usage: false }, usage: false, contextWindow: true },
    { legacy: false, items: { usage: true, retired: false }, usage: true, contextWindow: true },
    // Choices saved under the retired "context" id no longer hide the Context window.
    { legacy: false, items: { context: false }, usage: false, contextWindow: true },
    { legacy: true, items: { context: false }, usage: true, contextWindow: true },
    { legacy: false, items: { contextWindow: false }, usage: false, contextWindow: false },
  ])("resolves Usage and Context window from overrides and the retired Labs flag: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.contextWindow).toBe(row.contextWindow);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    const legacyOn = { threadDetailsItems: {}, threadDetailsUsageEnabled: true };
    expect(setThreadDetailsItem(legacyOn, usage, false)).toEqual({ usage: false });
    expect(setThreadDetailsItem(legacyOn, usage, true)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });

  it("remembers turning the Context window off after the reset", () => {
    const stale = { threadDetailsItems: { context: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(stale, contextWindow, false)).toEqual({
      context: false,
      contextWindow: false,
    });
    expect(setThreadDetailsItem(stale, contextWindow, true)).toEqual({ context: false });
  });
});
