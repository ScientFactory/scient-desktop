import { msg } from "gt-react";

import { WRITING_COMMANDS, TABLE_COMMANDS } from "./writingCommands";
import { MATH_COMMANDS } from "../math/input/catalog";
import { defaultMathBindings } from "../math/input/keymap";
import { SHORTCUTS } from "../markdownEditor/shortcutDefinitions";

export type KeyboardScope = "markdown" | "math" | "pdf" | "latex" | "table";
export interface SurfaceCommand {
  readonly id: string;
  /** Resolve with `useMessages()` where it shows. */
  readonly label: string;
  readonly scope: KeyboardScope;
  readonly defaultKeys: readonly string[];
}
const markdownActions = [
  ["bold", msg("Bold")],
  ["italic", msg("Emphasis / italic")],
  ["inlineCode", msg("Inline code")],
  ["strike", msg("Strikethrough")],
  ["link", msg("Link")],
  ["find", msg("Find")],
  ["paragraph", msg("Normal paragraph")],
  ["heading1", msg("Heading 1")],
  ["heading2", msg("Heading 2")],
  ["heading3", msg("Heading 3")],
  ["heading4", msg("Heading 4")],
  ["heading5", msg("Heading 5")],
  ["heading6", msg("Heading 6")],
  ["orderedList", msg("Numbered list")],
  ["bulletList", msg("Bullet list")],
  ["taskList", msg("Task list")],
  ["clearFormatting", msg("Clear formatting")],
  ["fontSizeLarger", msg("Larger text size")],
  ["fontSizeSmaller", msg("Smaller text size")],
  ["moveBlockUp", msg("Move block up")],
  ["moveBlockDown", msg("Move block down")],
  ["duplicateBlock", msg("Duplicate block")],
] as const;
const commandCache = new Map<boolean, readonly SurfaceCommand[]>();
export function surfaceCommands(mac: boolean): readonly SurfaceCommand[] {
  const cached = commandCache.get(mac);
  if (cached) return cached;
  const mathBindings = defaultMathBindings(mac);
  const math = new Map(MATH_COMMANDS.map((command) => [command.id, command.label]));
  for (const [id, label] of [
    ["math.inline", msg("Inline equation")],
    ["math.display", msg("Display equation")],
    ["math.palette", msg("Math and symbols")],
    ["math.matrix.addRow", msg("Matrix: add row")],
    ["math.matrix.deleteRow", msg("Matrix: delete row")],
    ["math.matrix.copyRow", msg("Matrix: copy row (Markdown)")],
    ["math.matrix.swapRow", msg("Matrix: swap row (Markdown)")],
    ["math.matrix.addColumn", msg("Matrix: add column")],
    ["math.matrix.deleteColumn", msg("Matrix: delete column")],
    ["math.matrix.copyColumn", msg("Matrix: copy column (Markdown)")],
    ["math.matrix.swapColumn", msg("Matrix: swap column (Markdown)")],
  ])
    math.set(id!, label!);
  const commands: readonly SurfaceCommand[] = [
    ...WRITING_COMMANDS.map(([id, label, defaultKeys]) => ({
      id: "latex." + id,
      label,
      scope: "latex" as const,
      defaultKeys,
    })),
    ...TABLE_COMMANDS.map(([id, label, defaultKeys]) => ({
      id: "table." + id,
      label,
      scope: "table" as const,
      defaultKeys,
    })),
    ...markdownActions.map(([id, label]) => ({
      id: "markdown." + id,
      label,
      scope: "markdown" as const,
      defaultKeys: SHORTCUTS[id].bindings.map((binding) =>
        [
          ...(binding.modKey ? ["mod"] : []),
          ...(binding.ctrlKey ? ["ctrl"] : []),
          ...(binding.metaKey ? ["meta"] : []),
          ...(binding.altKey ? ["alt"] : []),
          ...(binding.shiftKey ? ["shift"] : []),
          binding.key,
        ].join("+"),
      ),
    })),
    ...[...math].map(([id, label]) => ({
      id,
      label,
      scope: "math" as const,
      defaultKeys: mathBindings
        .filter((binding) => binding.command === id)
        .map((binding) => binding.keys),
    })),
    { id: "pdf.find", label: msg("Find in PDF"), scope: "pdf", defaultKeys: ["mod+f"] },
    {
      id: "pdf.zoomIn",
      label: msg("Zoom document in"),
      scope: "pdf",
      defaultKeys: ["alt+arrowup"],
    },
    {
      id: "pdf.zoomOut",
      label: msg("Zoom document out"),
      scope: "pdf",
      defaultKeys: ["alt+arrowdown"],
    },
    {
      id: "pdf.actualSize",
      label: msg("Document actual size"),
      scope: "pdf",
      defaultKeys: ["alt+0"],
    },
  ];
  commandCache.set(mac, commands);
  return commands;
}
/**
 * Math may be nested in Markdown or LaTeX. A LaTeX table's cells hold LaTeX
 * text and math, so the same key reaches the table and what is in the cell.
 * PDF read mode is disjoint from authoring.
 */
export function scopesOverlap(a: KeyboardScope, b: KeyboardScope) {
  if (a === b) return true;
  if (a === "pdf" || b === "pdf") return false;
  if (a === "math" || b === "math") return true;
  if (a === "table" || b === "table") return a === "latex" || b === "latex";
  return false;
}
