/** Semantic commands shared by Settings, editor adapters, and the reference sheet. */
export const WRITING_COMMANDS = [
  ["bold", "Bold", ["mod+b", "alt+c b"]],
  ["italic", "Emphasis / italic", ["mod+i", "alt+c e"]],
  ["paragraph", "Normal paragraph", ["alt+p s"]],
  ["section", "Section", ["alt+p 1"]],
  ["subsection", "Subsection", ["alt+p 2"]],
  ["subsubsection", "Subsubsection", ["alt+p 3"]],
  ["bulletList", "Bullet list", ["alt+p b"]],
  ["orderedList", "Numbered list", ["alt+p n"]],
  ["footnote", "Insert footnote", ["alt+i f"]],
  ["reference", "Citation or cross-reference", ["alt+i r"]],
  ["figure", "Insert figure", ["alt+i g"]],
  ["table", "Insert table", ["alt+i t"]],
  ["pagebreak", "Page break", ["alt+i p"]],
  ["outline", "Document outline", ["alt+o o"]],
  ["shortcuts", "Shortcuts and reference", ["alt+o k"]],
] as const;

export const SOURCE_COMMANDS = [
  ["find", "Find / replace", ["mod+f", "mod+h"]],
  ["gotoLine", "Go to line", ["mod+shift+l"]],
  ["comment", "Toggle comment", ["mod+/"]],
  ["indent", "Indent selection", ["mod+shift+f"]],
  ["definition", "Go to definition", ["f12"]],
  ["pdf", "Find selection in PDF", ["mod+shift+j"]],
  ["build", "Update PDF after saving", ["mod+enter"]],
  ["fold", "Fold all", ["alt+o f"]],
  ["unfold", "Unfold all", ["alt+o u"]],
] as const;

export const TABLE_COMMANDS = [
  ["addRow", "Table: add row below", ["alt+t r a"]],
  ["deleteRow", "Table: delete row", ["alt+t r d"]],
  ["addColumn", "Table: add column after", ["alt+t c a"]],
  ["deleteColumn", "Table: delete column", ["alt+t c d"]],
] as const;
