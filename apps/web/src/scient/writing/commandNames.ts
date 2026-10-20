/**
 * The one name for each writing command that more than one document editor
 * offers. Bars, menus and slash menus take their wording from here, so a
 * command cannot be called "Bullet list" in one place and "Bulleted list" in
 * another. Each editor keeps its own code for carrying the command out.
 */
export const WRITING_COMMAND_LABELS = {
  undo: "Undo",
  redo: "Redo",
  bold: "Bold",
  italic: "Italic",
  inlineCode: "Inline code",
  link: "Link",
  text: "Text",
  quote: "Quote",
  bulletList: "Bullet list",
  numberedList: "Numbered list",
  noList: "No list",
  insert: "Insert",
} as const;

export type WritingCommandId = keyof typeof WRITING_COMMAND_LABELS;

/** Glyphs whose shape depends on their original line weight. */
export const WRITING_COMMANDS_KEEPING_ICON_WEIGHT: ReadonlySet<WritingCommandId> = new Set([
  "bold",
  "inlineCode",
  "link",
]);
