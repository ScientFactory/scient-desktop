/** Semantic commands shared by Settings, editor adapters, and the reference sheet. */
export const WRITING_COMMANDS = [
  ["bold", "Bold", ["mod+b", "alt+c b"]],
  ["italic", "Emphasis / italic", ["mod+i", "alt+c e"]],
  ["inlineCode", "Inline code", ["mod+e"]],
  ["link", "Link", ["mod+k"]],
  ["paragraph", "Normal paragraph", ["mod+alt+0", "alt+p s"]],
  ["section", "Section", ["mod+alt+1", "alt+p 1"]],
  ["subsection", "Subsection", ["mod+alt+2", "alt+p 2"]],
  ["subsubsection", "Subsubsection", ["mod+alt+3", "alt+p 3"]],
  ["bulletList", "Bullet list", ["mod+shift+8", "alt+p b"]],
  ["orderedList", "Numbered list", ["mod+shift+7", "alt+p n"]],
  ["footnote", "Insert footnote", ["alt+i f"]],
  ["reference", "Citation or cross-reference", ["alt+i r"]],
  ["figure", "Insert figure", ["alt+i g"]],
  ["table", "Insert table", ["alt+i t"]],
  ["pagebreak", "Page break", ["alt+i p"]],
  ["outline", "Document outline", ["alt+o o"]],
  ["shortcuts", "Shortcuts and reference", ["alt+o k"]],
  ["selectionExpand", "Expand selection", ["alt+shift+arrowup"]],
  ["selectionScopeExpand", "Select current scope, then parent", ["mod+a"]],
  ["selectionShrink", "Shrink selection", ["alt+shift+arrowdown"]],
  ["enterScope", "Enter formatting scope", ["mod+alt+arrowdown"]],
  ["leaveParentBefore", "Leave parent before", ["mod+alt+arrowleft"]],
  ["leaveParentAfter", "Leave parent after", ["mod+alt+arrowright"]],
] as const;

export const TABLE_COMMANDS = [
  ["addRow", "Table: add row below", ["alt+t r a"]],
  ["deleteRow", "Table: delete row", ["alt+t r d"]],
  ["addColumn", "Table: add column after", ["alt+t c a"]],
  ["deleteColumn", "Table: delete column", ["alt+t c d"]],
] as const;
