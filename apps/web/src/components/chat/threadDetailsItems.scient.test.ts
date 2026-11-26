import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobals } from "../../../test/scientAppWindows";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";
import {
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  saveThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;
const usageLimits = THREAD_DETAILS_ITEMS.find((item) => item.id === "usageLimits")!;

/** A desktop window whose snapshot is `current` while another window has already saved `saved`. */
function desktopWindow(current: ClientSettings, saved: ClientSettings) {
  persistence.getClientSettings.mockReset().mockResolvedValue(saved);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  const globals = stubGlobals({
    window: Object.assign(new EventTarget(), {
      desktopBridge: { onClientSettingsChanged: () => () => undefined },
    }),
    navigator: { locks: { request: (_name: string, callback: () => unknown) => callback() } },
  });
  __setClientSettingsForTests(current);
  return {
    [Symbol.dispose]: () => {
      __resetClientSettingsPersistenceForTests();
      globals[Symbol.dispose]();
    },
  };
}

describe("Usage limits in thread details", () => {
  it.each([
    { legacy: false, items: {}, visible: true },
    // Choices saved under the retired "usage" id no longer hide it, so it turns on once for everyone.
    { legacy: false, items: { usage: false }, visible: true },
    { legacy: true, items: { usage: false }, visible: true },
    { legacy: false, items: { usage: false, usageLimits: false }, visible: false },
  ])("is shown unless turned off under its current id: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.usageLimits).toBe(row.visible);
  });

  it("leaves Context window off when #1143's contextWindow choice is still saved", () => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: { contextWindow: true },
      threadDetailsUsageEnabled: false,
    });
    expect(visibility.context).toBe(false);
  });

  it("Reset to default shows Usage limits and hides Context window", () => {
    const saved = { threadDetailsItems: { usageLimits: false }, threadDetailsUsageEnabled: true };
    const visibility = resolveThreadDetailsVisibility({ ...saved, ...RESET_THREAD_DETAILS_ITEMS });
    expect(visibility).toMatchObject({ usageLimits: true, context: false });
  });

  it("stays off when another window hides a different item before hearing about it", async () => {
    using _window = desktopWindow(DEFAULT_CLIENT_SETTINGS, {
      ...DEFAULT_CLIENT_SETTINGS,
      threadDetailsItems: { usageLimits: false },
    });

    await saveThreadDetailsItem(servers, false);

    expect(persistence.setClientSettings.mock.lastCall?.[0].threadDetailsItems).toEqual({
      usageLimits: false,
      servers: false,
    });
  });

  it("drops the saved opt-out when turned back on, leaving retired ids alone", async () => {
    const off = {
      ...DEFAULT_CLIENT_SETTINGS,
      threadDetailsItems: { usage: false, usageLimits: false },
    };
    using _window = desktopWindow(off, off);

    await saveThreadDetailsItem(usageLimits, true);

    expect(persistence.setClientSettings.mock.lastCall?.[0].threadDetailsItems).toEqual({
      usage: false,
    });
  });
});
