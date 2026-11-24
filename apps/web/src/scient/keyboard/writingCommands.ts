import { msg } from "gt-react";

/** Semantic commands shared by Settings, editor adapters, and the reference sheet. */
export const WRITING_COMMANDS = [
  ["bold", msg("Bold"), ["mod+b", "alt+c b"]],
  ["italic", msg("Emphasis / italic"), ["mod+i", "alt+c e"]],
  ["inlineCode", msg("Inline code"), ["mod+e"]],
  ["link", msg("Link"), ["mod+k"]],
  ["fontSizeLarger", msg("Larger text size"), ["mod+shift+."]],
  ["fontSizeSmaller", msg("Smaller text size"), ["mod+shift+,"]],
  ["paragraph", msg("Normal paragraph"), ["mod+alt+0", "alt+p s"]],
  ["section", msg("Section"), ["mod+alt+1", "alt+p 1"]],
  ["subsection", msg("Subsection"), ["mod+alt+2", "alt+p 2"]],
  ["subsubsection", msg("Subsubsection"), ["mod+alt+3", "alt+p 3"]],
  ["bulletList", msg("Bullet list"), ["mod+shift+8", "alt+p b"]],
  ["orderedList", msg("Numbered list"), ["mod+shift+7", "alt+p n"]],
  ["footnote", msg("Insert footnote"), ["alt+i f"]],
  ["reference", msg("Citation or cross-reference"), ["alt+i r"]],
  ["figure", msg("Insert figure"), ["alt+i g"]],
  ["table", msg("Insert table"), ["alt+i t"]],
  ["pagebreak", msg("Page break"), ["alt+i p"]],
  ["outline", msg("Document outline"), ["alt+o o"]],
  ["shortcuts", msg("Shortcuts and reference"), ["alt+o k"]],
  ["selectionExpand", msg("Expand selection"), ["alt+shift+arrowup"]],
  ["selectionScopeExpand", msg("Select current scope, then parent"), ["mod+a"]],
  ["selectionShrink", msg("Shrink selection"), ["alt+shift+arrowdown"]],
  ["enterScope", msg("Enter formatting scope"), ["mod+alt+arrowdown"]],
  ["leaveParentBefore", msg("Leave parent before"), ["mod+alt+arrowleft"]],
  ["leaveParentAfter", msg("Leave parent after"), ["mod+alt+arrowright"]],
] as const;

export const TABLE_COMMANDS = [
  ["addRow", msg("Table: add row below"), ["alt+t r a"]],
  ["deleteRow", msg("Table: delete row"), ["alt+t r d"]],
  ["addColumn", msg("Table: add column after"), ["alt+t c a"]],
  ["deleteColumn", msg("Table: delete column"), ["alt+t c d"]],
] as const;
