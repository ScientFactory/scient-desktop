import { markdownKeymap } from "@codemirror/lang-markdown";
import { openSearchPanel } from "@codemirror/search";
import { keymap } from "@codemirror/view";

import { toggleWrap } from "./commands";

/** Markdown editing keymap: formatting toggles, find, and list continuation. */
export const markdownEditingKeymap = keymap.of([
  { key: "Mod-b", run: (view) => toggleWrap(view, "**") },
  { key: "Mod-i", run: (view) => toggleWrap(view, "*") },
  { key: "Mod-f", run: openSearchPanel },
  ...markdownKeymap,
]);
