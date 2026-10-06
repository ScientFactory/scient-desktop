// SCIENT-OWNED: Scient's desktop settings transitions. DesktopAppSettings.ts calls
// these from short marked lines; they are pure functions of the settings value.
import { VoiceModelId as VoiceModelIdSchema, type VoiceModelId } from "@t3tools/contracts";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Schema from "effect/Schema";

import type { DesktopSettings, DesktopWindowBounds } from "./DesktopAppSettings.ts";

const isVoiceModelId = Schema.is(VoiceModelIdSchema);

export function applyMainWindowSizeIncrease(
  settings: DesktopSettings,
  bounds: DesktopWindowBounds | null,
): DesktopSettings {
  return settings.mainWindowSizeIncreaseApplied
    ? settings
    : {
        ...settings,
        mainWindowBounds: bounds,
        mainWindowMaximized: bounds !== null && settings.mainWindowMaximized,
        mainWindowSizeIncreaseApplied: true,
      };
}

export function applyMainWindowNearFullSize(
  settings: DesktopSettings,
  bounds: DesktopWindowBounds | null,
): DesktopSettings {
  return settings.mainWindowNearFullSizeApplied
    ? settings
    : {
        ...settings,
        mainWindowBounds: bounds,
        mainWindowMaximized: bounds !== null && settings.mainWindowMaximized,
        mainWindowNearFullSizeApplied: true,
      };
}

/** Stable-only products keep the latest channel, whatever the stored document says. */
export function stableOnlyUpdateChannelFields():
  | {
      readonly updateChannel: "latest";
      readonly updateChannelConfiguredByUser: false;
    }
  | Record<never, never> {
  return SCIENT_DESKTOP_IDENTITY.desktopUpdateChannelPolicy === "stable-only"
    ? {
        updateChannel: "latest" as const,
        updateChannelConfiguredByUser: false,
      }
    : {};
}

/**
 * The stable-only channel transition, or `undefined` when the product lets the
 * user choose and the inherited transition applies.
 */
export function stableOnlyUpdateChannel(settings: DesktopSettings): DesktopSettings | undefined {
  if (SCIENT_DESKTOP_IDENTITY.desktopUpdateChannelPolicy !== "stable-only") {
    return undefined;
  }

  return settings.updateChannel === "latest" && !settings.updateChannelConfiguredByUser
    ? settings
    : {
        ...settings,
        updateChannel: "latest",
        updateChannelConfiguredByUser: false,
      };
}

export function normalizeVoiceSelectedModelId(
  value: string | null | undefined,
): VoiceModelId | null {
  return isVoiceModelId(value) ? value : null;
}

export function setVoiceSelectedModelId(
  settings: DesktopSettings,
  modelId: VoiceModelId | null,
): DesktopSettings {
  return settings.voiceSelectedModelId === modelId
    ? settings
    : {
        ...settings,
        voiceSelectedModelId: modelId,
      };
}
