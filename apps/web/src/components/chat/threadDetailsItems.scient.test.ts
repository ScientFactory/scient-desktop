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
  saveThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;
const contextWindow = THREAD_DETAILS_ITEMS.find((item) => item.id === "contextWindow")!;

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

describe("Context window in thread details", () => {
  it.each([
    { legacy: false, items: {}, visible: true },
    // Choices saved under the retired "context" id no longer hide it, so it turns on once for everyone.
    { legacy: false, items: { context: false }, visible: true },
    { legacy: true, items: { context: false }, visible: true },
    { legacy: false, items: { context: false, contextWindow: false }, visible: false },
  ])("is shown unless turned off under its current id: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.contextWindow).toBe(row.visible);
  });

  it("stays off when another window hides a different item before hearing about it", async () => {
    using _window = desktopWindow(DEFAULT_CLIENT_SETTINGS, {
      ...DEFAULT_CLIENT_SETTINGS,
      threadDetailsItems: { contextWindow: false },
    });

    await saveThreadDetailsItem(servers, false);

    expect(persistence.setClientSettings.mock.lastCall?.[0].threadDetailsItems).toEqual({
      contextWindow: false,
      servers: false,
    });
  });

  it("drops the saved opt-out when turned back on, leaving retired ids alone", async () => {
    const off = {
      ...DEFAULT_CLIENT_SETTINGS,
      threadDetailsItems: { context: false, contextWindow: false },
    };
    using _window = desktopWindow(off, off);

    await saveThreadDetailsItem(contextWindow, true);

    expect(persistence.setClientSettings.mock.lastCall?.[0].threadDetailsItems).toEqual({
      context: false,
    });
  });
});
