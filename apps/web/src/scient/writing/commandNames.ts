import { msg } from "gt-react";

/**
 * The one name for each writing command that more than one document editor
 * offers. Bars, menus and slash menus take their wording from here, so a
 * command cannot be called "Bullet list" in one place and "Bulleted list" in
 * another. Labels are `msg()` strings: resolve them where they show.
 */
export const WRITING_COMMAND_LABELS = {
  undo: msg("Undo"),
  redo: msg("Redo"),
  bold: msg("Bold"),
  italic: msg("Italic"),
  inlineCode: msg("Inline code"),
  link: msg("Link"),
  text: msg("Text"),
  quote: msg("Quote"),
  bulletList: msg("Bullet list"),
  numberedList: msg("Numbered list"),
  noList: msg("No list"),
  insert: msg("Insert"),
} as const;

export type WritingCommandId = keyof typeof WRITING_COMMAND_LABELS;
