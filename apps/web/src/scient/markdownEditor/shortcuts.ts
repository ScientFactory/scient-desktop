import type { KeybindingShortcut } from "@t3tools/contracts";

import { formatShortcutLabel } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";

import { commandKeys } from "../keyboard/preferences";
import { surfaceCommands } from "../keyboard/catalog";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

export {
  SCIENT_MARKDOWN_FOCUS_SHORTCUT_IDS,
  SCIENT_MARKDOWN_COMMAND_SHORTCUTS,
} from "./shortcutDefinitions";
export type {
  ScientMarkdownShortcutId,
  ScientMarkdownShortcutPresentation,
} from "./shortcutDefinitions";
import {
  SHORTCUTS,
  type ShortcutDefinition,
  type ScientMarkdownShortcutId,
  type ScientMarkdownShortcutPresentation,
} from "./shortcutDefinitions";

function runtimePlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function primaryBinding(definition: ShortcutDefinition, platform: string): KeybindingShortcut {
  const index = isMacPlatform(platform) ? (definition.macPrimary ?? 0) : 0;
  return definition.bindings[index] ?? definition.bindings[0]!;
}

function orderedBindings(
  definition: ShortcutDefinition,
  platform: string,
): readonly KeybindingShortcut[] {
  const primary = primaryBinding(definition, platform);
  return [primary, ...definition.bindings.filter((binding) => binding !== primary)];
}

function compactMacKeyLabel(label: string, key: string): string {
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

function ariaShortcut(binding: KeybindingShortcut, platform: string): string {
  const mac = isMacPlatform(platform);
  const parts: string[] = [];
  if (binding.ctrlKey || (binding.modKey && !mac)) parts.push("Control");
  if (binding.metaKey || (binding.modKey && mac)) parts.push("Meta");
  if (binding.altKey) parts.push("Alt");
  if (binding.shiftKey) parts.push("Shift");
  parts.push(ariaKeyLabel(binding.key));
  return parts.join("+");
}

/** One source of truth for tooltip text and assistive shortcut metadata. */
export function scientMarkdownShortcut(
  id: ScientMarkdownShortcutId,
  platform = runtimePlatform(),
): ScientMarkdownShortcutPresentation {
  const configurable = surfaceCommands(isMacPlatform(platform)).some(
    (command) => command.id === "markdown." + id,
  );
  if (configurable) {
    const keys = commandKeys("markdown." + id, isMacPlatform(platform));
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
  const definition = SHORTCUTS[id];
  const bindings = orderedBindings(definition, platform);
  const primary = bindings[0]!;
  const display = formatShortcutLabel(primary, platform);
  return {
    display: isMacPlatform(platform) ? compactMacKeyLabel(display, primary.key) : display,
    ariaKeyShortcuts: bindings.map((binding) => ariaShortcut(binding, platform)).join(" "),
  };
}

function prosemirrorKeyName(binding: KeybindingShortcut): string {
  const modifiers: string[] = [];
  if (binding.modKey) modifiers.push("Mod");
  if (binding.metaKey) modifiers.push("Meta");
  if (binding.ctrlKey) modifiers.push("Ctrl");
  if (binding.altKey) modifiers.push("Alt");
  if (binding.shiftKey) modifiers.push("Shift");
  const key =
    binding.key === "enter"
      ? "Enter"
      : binding.key === "escape"
        ? "Escape"
        : binding.key === "arrowup"
          ? "ArrowUp"
          : binding.key === "arrowdown"
            ? "ArrowDown"
            : binding.key === "arrowleft"
              ? "ArrowLeft"
              : binding.key === "arrowright"
                ? "ArrowRight"
                : binding.key;
  return [...modifiers, key].join("-");
}

/** Key names consumed by `prosemirror-keymap`, derived from the same UI catalog. */
export function scientMarkdownKeymapNames(id: ScientMarkdownShortcutId): readonly string[] {
  const configurable = surfaceCommands(isMacPlatform(runtimePlatform())).some(
    (command) => command.id === "markdown." + id,
  );
  if (configurable)
    return commandKeys("markdown." + id)
      .filter((key) => !key.includes(" "))
      .flatMap((key) => {
        const binding = parseKeybindingShortcut(key.replaceAll("plus", "+"));
        return binding ? [prosemirrorKeyName(binding)] : [];
      });
  return SHORTCUTS[id].bindings.map(prosemirrorKeyName);
}

const CODE_ALIASES: Readonly<Record<string, string>> = {
  Backslash: "\\",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
};

function eventKeys(event: Pick<KeyboardEvent, "code" | "key">): ReadonlySet<string> {
  const normalized = event.key.toLocaleLowerCase();
  const keys = new Set([normalized === "esc" ? "escape" : normalized]);
  const physicalLetter = event.code.match(/^Key([A-Z])$/u)?.[1];
  if (physicalLetter && !/^[a-z]$/u.test(normalized)) {
    keys.add(physicalLetter.toLocaleLowerCase());
  }
  const alias = CODE_ALIASES[event.code];
  if (alias) keys.add(alias);
  return keys;
}

function matchesBinding(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  binding: KeybindingShortcut,
  platform: string,
): boolean {
  const mac = isMacPlatform(platform);
  const expectedMeta = binding.metaKey || (binding.modKey && mac);
  const expectedControl = binding.ctrlKey || (binding.modKey && !mac);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedControl &&
    event.altKey === binding.altKey &&
    event.shiftKey === binding.shiftKey &&
    eventKeys(event).has(binding.key)
  );
}

/** Exact-modifier match with a physical-key fallback for non-Latin layouts. */
export function matchesScientMarkdownShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  id: ScientMarkdownShortcutId,
  platform = runtimePlatform(),
): boolean {
  const configurable = surfaceCommands(isMacPlatform(platform)).some(
    (command) => command.id === "markdown." + id,
  );
  const bindings = configurable
    ? commandKeys("markdown." + id, isMacPlatform(platform))
        .filter((key) => !key.includes(" "))
        .flatMap((key) => {
          const binding = parseKeybindingShortcut(key.replaceAll("plus", "+"));
          return binding ? [binding] : [];
        })
    : SHORTCUTS[id].bindings;
  return bindings.some((binding) => matchesBinding(event, binding, platform));
}
