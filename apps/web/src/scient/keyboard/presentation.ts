import type { KeybindingShortcut } from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import { formatShortcutLabel } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";

import { commandKeys } from "./preferences";

/** How a shortcut is shown next to a command, and announced by assistive technology. */
export interface ShortcutPresentation {
  /** Human-facing platform label, kept out of the control's accessible name. */
  readonly display: string;
  /** One or more valid ARIA shortcut tokens, primary first. */
  readonly ariaKeyShortcuts: string;
}

export function runtimePlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export function compactMacKeyLabel(label: string, key: string): string {
  const replacement =
    key === "enter"
      ? "↩"
      : key === "arrowup"
        ? "↑"
        : key === "arrowdown"
          ? "↓"
          : key === "arrowleft"
            ? "←"
            : key === "arrowright"
              ? "→"
              : null;
  if (replacement === null) return label;
  const longLabel =
    key === "enter"
      ? "Enter"
      : key === "arrowup"
        ? "Up"
        : key === "arrowdown"
          ? "Down"
          : key === "arrowleft"
            ? "Left"
            : "Right";
  return label.endsWith(longLabel) ? `${label.slice(0, -longLabel.length)}${replacement}` : label;
}

function ariaKeyLabel(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Escape";
  if (key === "enter") return "Enter";
  if (key === "arrowup") return "ArrowUp";
  if (key === "arrowdown") return "ArrowDown";
  if (key === "arrowleft") return "ArrowLeft";
  if (key === "arrowright") return "ArrowRight";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function ariaShortcut(binding: KeybindingShortcut, platform: string): string {
  const mac = isMacPlatform(platform);
  const parts: string[] = [];
  if (binding.ctrlKey || (binding.modKey && !mac)) parts.push("Control");
  if (binding.metaKey || (binding.modKey && mac)) parts.push("Meta");
  if (binding.altKey) parts.push("Alt");
  if (binding.shiftKey) parts.push("Shift");
  parts.push(ariaKeyLabel(binding.key));
  return parts.join("+");
}

export function presentCommandKeys(commandId: string, platform: string): ShortcutPresentation {
  const keys = commandKeys(commandId, isMacPlatform(platform));
  return {
    display: keys
      .map((key) =>
        key
          .split(" ")
          .map((stroke) => {
            const binding = parseKeybindingShortcut(stroke.replaceAll("plus", "+"));
            if (!binding) return stroke;
            const label = formatShortcutLabel(binding, platform);
            return isMacPlatform(platform) ? compactMacKeyLabel(label, binding.key) : label;
          })
          .join(" → "),
      )
      .join(" / "),
    ariaKeyShortcuts: keys
      .filter((key) => !key.includes(" "))
      .flatMap((key) => {
        const binding = parseKeybindingShortcut(key.replaceAll("plus", "+"));
        return binding ? [ariaShortcut(binding, platform)] : [];
      })
      .join(" "),
  };
}

/** The presentation of any configurable writing command, such as `latex.bold`. */
export function commandShortcut(
  commandId: string,
  platform = runtimePlatform(),
): ShortcutPresentation | undefined {
  return commandKeys(commandId, isMacPlatform(platform)).length > 0
    ? presentCommandKeys(commandId, platform)
    : undefined;
}

/** For a menu row: the first key only. The shortcuts list shows every key. */
export function menuShortcut(
  commandId: string,
  platform = runtimePlatform(),
): ShortcutPresentation | undefined {
  const shortcut = commandShortcut(commandId, platform);
  return shortcut ? { ...shortcut, display: shortcut.display.split(" / ")[0]! } : undefined;
}
