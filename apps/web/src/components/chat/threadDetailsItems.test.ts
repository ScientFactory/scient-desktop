import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const context = THREAD_DETAILS_ITEMS.find((item) => item.id === "context")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;

describe("thread details items", () => {
  it.each([
    { legacy: false, items: {}, usageLimits: true, context: false },
    { legacy: true, items: {}, usageLimits: true, context: true },
    { legacy: true, items: { context: false }, usageLimits: true, context: false },
    { legacy: false, items: { context: true, retired: false }, usageLimits: true, context: true },
  ])(
    "resolves Usage limits and Context window from overrides and the retired Labs flag: %o",
    (row) => {
      const visibility = resolveThreadDetailsVisibility({
        threadDetailsItems: row.items,
        threadDetailsUsageEnabled: row.legacy,
      });
      expect(visibility.usageLimits).toBe(row.usageLimits);
      expect(visibility.context).toBe(row.context);
      expect(visibility.servers).toBe(true);
    },
  );

  it("stores only choices that differ from the default", () => {
    const legacyOn = { threadDetailsItems: {}, threadDetailsUsageEnabled: true };
    expect(setThreadDetailsItem(legacyOn, context, false)).toEqual({ context: false });
    expect(setThreadDetailsItem(legacyOn, context, true)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });
});
