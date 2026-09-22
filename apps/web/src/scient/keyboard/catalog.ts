import { MATH_COMMANDS } from "../math/input/catalog";
import { defaultMathBindings } from "../math/input/keymap";
import { SHORTCUTS } from "../markdownEditor/shortcutDefinitions";

export type KeyboardScope = "markdown" | "math" | "pdf";
export interface SurfaceCommand {
  readonly id: string;
  readonly label: string;
  readonly scope: KeyboardScope;
  readonly defaultKeys: readonly string[];
}
const markdownActions = [
  "bold",
  "italic",
  "inlineCode",
  "strike",
  "link",
  "find",
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
  "moveBlockUp",
  "moveBlockDown",
  "duplicateBlock",
] as const;
const commandCache = new Map<boolean, readonly SurfaceCommand[]>();
export function surfaceCommands(mac: boolean): readonly SurfaceCommand[] {
  const cached = commandCache.get(mac);
  if (cached) return cached;
  const mathBindings = defaultMathBindings(mac);
  const math = new Map(MATH_COMMANDS.map((command) => [command.id, command.label]));
  for (const [id, label] of [
    ["math.inline", "Inline equation"],
    ["math.display", "Display equation"],
    ["math.palette", "Math and symbols"],
  ])
    math.set(id!, label!);
  for (const action of [
    "addRow",
    "deleteRow",
    "copyRow",
    "swapRow",
    "addColumn",
    "deleteColumn",
    "copyColumn",
    "swapColumn",
  ])
    math.set(
      "math.matrix." + action,
      "Matrix: " + action.replace(/([A-Z])/gu, " $1").toLowerCase(),
    );
  const commands: readonly SurfaceCommand[] = [
    ...markdownActions.map((id) => ({
      id: "markdown." + id,
      label: id.replace(/([A-Z0-9])/gu, " $1"),
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
    { id: "pdf.find", label: "Find in PDF", scope: "pdf", defaultKeys: ["mod+f"] },
    {
      id: "pdf.zoomIn",
      label: "Zoom document in",
      scope: "pdf",
      defaultKeys: ["alt+arrowup"],
    },
    { id: "pdf.zoomOut", label: "Zoom document out", scope: "pdf", defaultKeys: ["alt+arrowdown"] },
    { id: "pdf.actualSize", label: "Document actual size", scope: "pdf", defaultKeys: ["alt+0"] },
  ];
  commandCache.set(mac, commands);
  return commands;
}
/** Math may be nested in Markdown; PDF read mode is disjoint from authoring. */
export function scopesOverlap(a: KeyboardScope, b: KeyboardScope) {
  return a === b || (a !== "pdf" && b !== "pdf");
}
