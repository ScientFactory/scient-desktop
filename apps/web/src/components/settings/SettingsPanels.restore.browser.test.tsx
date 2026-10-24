import { useEffect } from "react";
import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () =>
    ({
      theme: "system",
      followSystem: true,
      themeHalves: null,
      setTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setThemeHalf: vi.fn(),
      clearThemeHalves: vi.fn(),
    }) as never,
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings!) as never,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

import { useSettingsRestore } from "./useSettingsRestore";

async function renderRestore() {
  let restore!: ReturnType<typeof useSettingsRestore>;
  function Probe() {
    const result = useSettingsRestore();
    useEffect(() => {
      restore = result;
    });
    return (
      <button
        disabled={result.changedSettingLabels.length === 0}
        onClick={() => void result.restoreDefaults()}
      >
        Restore defaults
      </button>
    );
  }
  const screen = await render(<Probe />);
  return {
    ...screen,
    refresh: () => screen.rerender(<Probe />),
    get restore() {
      return restore;
    },
  };
}
function setup() {
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.update.mockImplementation((patch: Partial<UnifiedSettings>) => {
    state.settings = { ...state.settings!, ...patch };
  });
  state.confirm.mockResolvedValue(true);
}

describe("restoring V2 settings", () => {
  it("restores title instructions alone through the extracted scoped owner", async () => {
    setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      threadTitleInstructions: "Lead with the subject",
    };
    await using screen = await renderRestore();
    expect(screen.restore.changedSettingLabels).toEqual(["Thread title instructions"]);
    await screen.getByRole("button", { name: "Restore defaults" }).click();
    expect(state.confirm.mock.calls[0]?.[0]).toContain("Thread title instructions");
    expect(state.update.mock.calls[0]?.[0].threadTitleInstructions).toBe("");
    expect(state.update.mock.calls[0]?.[0]).not.toHaveProperty("mathRenderingEnabled");
    await screen.refresh();
    expect(screen.restore.changedSettingLabels).toEqual([]);
  });
  it("enables restore for chat width alone and restores its default through the live hook", async () => {
    setup();
    await using screen = await renderRestore();
    await expect.element(screen.getByRole("button", { name: "Restore defaults" })).toBeDisabled();

    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      chatWidth: "full",
    };
    await screen.refresh();
    expect(screen.restore.changedSettingLabels).toEqual(["Chat width"]);
    const restoreButton = screen.getByRole("button", { name: "Restore defaults" });
    await expect.element(restoreButton).toBeEnabled();
    await restoreButton.click();

    expect(state.confirm.mock.calls[0]?.[0]).toContain("Chat width");
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0].chatWidth).toBe(DEFAULT_UNIFIED_SETTINGS.chatWidth);
    await screen.refresh();
    expect(screen.restore.changedSettingLabels).toEqual([]);
    await expect.element(restoreButton).toBeDisabled();
  });

  it("does not restore a chat-width-only change when confirmation is cancelled", async () => {
    setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      chatWidth: "full",
    };
    state.confirm.mockResolvedValue(false);
    await using screen = await renderRestore();
    await screen.getByRole("button", { name: "Restore defaults" }).click();
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("leaves the compatibility-only math preference unchanged when restoring live settings", async () => {
    setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      mathRenderingEnabled: true,
    };
    await using screen = await renderRestore();
    expect(screen.restore.changedSettingLabels).toEqual([]);
    await expect.element(screen.getByRole("button", { name: "Restore defaults" })).toBeDisabled();

    state.settings = { ...state.settings!, chatWidth: "full" };
    await screen.refresh();
    await screen.getByRole("button", { name: "Restore defaults" }).click();
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0]).not.toHaveProperty("mathRenderingEnabled");
    expect(state.settings?.mathRenderingEnabled).toBe(true);
    expect(state.settings?.chatWidth).toBe(DEFAULT_UNIFIED_SETTINGS.chatWidth);
  });
});
