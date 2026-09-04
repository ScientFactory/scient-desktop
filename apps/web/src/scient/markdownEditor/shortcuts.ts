import type { KeybindingShortcut } from "@t3tools/contracts";

import { formatShortcutLabel } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";

import type { ScientMarkdownCommand } from "./prosemirror/commands";

export type ScientMarkdownShortcutId =
  | "bold"
  | "bulletList"
  | "clearFormatting"
  | "close"
  | "copy"
  | "cut"
  | "duplicateBlock"
  | "find"
  | "findNext"
  | "findPrevious"
  | "hardBreak"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "inlineCode"
  | "italic"
  | "link"
  | "moveBlockDown"
  | "moveBlockUp"
  | "orderedList"
  | "paragraph"
  | "paste"
  | "pastePlainText"
  | "redo"
  | "replaceCurrent"
  | "selectAll"
  | "strike"
  | "taskList"
  | "undo";

/** Shortcuts owned while focus is within the Markdown editing surface. */
export const SCIENT_MARKDOWN_FOCUS_SHORTCUT_IDS = [
  "selectAll",
  "undo",
  "redo",
  "copy",
  "cut",
  "paste",
  "pastePlainText",
  "find",
  "bold",
  "italic",
  "inlineCode",
  "strike",
  "link",
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "orderedList",
  "bulletList",
  "taskList",
  "clearFormatting",
  "hardBreak",
  "moveBlockUp",
  "moveBlockDown",
  "duplicateBlock",
] as const satisfies ReadonlyArray<ScientMarkdownShortcutId>;

/** Shared routing for commands available from both the document and editor chrome. */
export const SCIENT_MARKDOWN_COMMAND_SHORTCUTS = [
  ["undo", "undo"],
  ["redo", "redo"],
  ["bold", "bold"],
  ["italic", "italic"],
  ["inlineCode", "inline-code"],
  ["strike", "strike"],
  ["paragraph", "paragraph"],
  ["heading1", "heading-1"],
  ["heading2", "heading-2"],
  ["heading3", "heading-3"],
  ["heading4", "heading-4"],
  ["heading5", "heading-5"],
  ["heading6", "heading-6"],
  ["orderedList", "ordered-list"],
  ["bulletList", "bullet-list"],
  ["taskList", "task-list"],
  ["clearFormatting", "clear-formatting"],
  ["hardBreak", "hard-break"],
] as const satisfies ReadonlyArray<readonly [ScientMarkdownShortcutId, ScientMarkdownCommand]>;

export interface ScientMarkdownShortcutPresentation {
  /** Human-facing platform label, kept out of the control's accessible name. */
  readonly display: string;
  /** One or more valid ARIA shortcut tokens, primary first. */
  readonly ariaKeyShortcuts: string;
}

interface ShortcutDefinition {
  readonly bindings: readonly KeybindingShortcut[];
  readonly macPrimary?: number;
}

const shortcut = (
  key: string,
  modifiers: Partial<
    Pick<KeybindingShortcut, "altKey" | "ctrlKey" | "metaKey" | "modKey" | "shiftKey">
  > = {},
): KeybindingShortcut => ({
  key,
  altKey: modifiers.altKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  metaKey: modifiers.metaKey ?? false,
  modKey: modifiers.modKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
});

const mod = (
  key: string,
  modifiers: Pick<Partial<KeybindingShortcut>, "altKey" | "shiftKey"> = {},
) => shortcut(key, { ...modifiers, modKey: true });

const SHORTCUTS = {
  selectAll: { bindings: [mod("a")] },
  undo: { bindings: [mod("z")] },
  redo: { bindings: [mod("y"), mod("z", { shiftKey: true })], macPrimary: 1 },
  copy: { bindings: [mod("c")] },
  cut: { bindings: [mod("x")] },
  paste: { bindings: [mod("v")] },
  pastePlainText: { bindings: [mod("v", { shiftKey: true })] },
  find: { bindings: [mod("f")] },
  bold: { bindings: [mod("b")] },
  italic: { bindings: [mod("i")] },
  inlineCode: { bindings: [mod("e")] },
  strike: { bindings: [mod("x", { shiftKey: true })] },
  link: { bindings: [mod("k")] },
  paragraph: { bindings: [mod("0", { altKey: true })] },
  heading1: { bindings: [mod("1", { altKey: true })] },
  heading2: { bindings: [mod("2", { altKey: true })] },
  heading3: { bindings: [mod("3", { altKey: true })] },
  heading4: { bindings: [mod("4", { altKey: true })] },
  heading5: { bindings: [mod("5", { altKey: true })] },
  heading6: { bindings: [mod("6", { altKey: true })] },
  orderedList: { bindings: [mod("7", { shiftKey: true })] },
  bulletList: { bindings: [mod("8", { shiftKey: true })] },
  taskList: { bindings: [mod("9", { shiftKey: true })] },
  clearFormatting: { bindings: [mod("\\")] },
  hardBreak: { bindings: [shortcut("enter", { shiftKey: true }), mod("enter")] },
  moveBlockUp: { bindings: [shortcut("arrowup", { altKey: true })] },
  moveBlockDown: { bindings: [shortcut("arrowdown", { altKey: true })] },
  duplicateBlock: { bindings: [shortcut("arrowdown", { altKey: true, shiftKey: true })] },
  findPrevious: { bindings: [shortcut("enter", { shiftKey: true })] },
  findNext: { bindings: [shortcut("enter")] },
  close: { bindings: [shortcut("escape")] },
  replaceCurrent: { bindings: [shortcut("enter")] },
} as const satisfies Record<ScientMarkdownShortcutId, ShortcutDefinition>;

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
  return SHORTCUTS[id].bindings.some((binding) => matchesBinding(event, binding, platform));
}
