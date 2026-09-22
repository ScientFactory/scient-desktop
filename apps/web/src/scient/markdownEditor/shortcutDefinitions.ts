import type { KeybindingShortcut } from "@t3tools/contracts";
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

export interface ShortcutDefinition {
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

export const SHORTCUTS = {
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
