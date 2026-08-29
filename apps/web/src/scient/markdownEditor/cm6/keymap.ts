import { markdownKeymap } from "@codemirror/lang-markdown";
import { keymap } from "@codemirror/view";

import { toggleWrap } from "./commands";

/** Markdown editing keymap: formatting toggles, find, and list continuation. */
export function markdownEditingKeymap(options: { readonly onFind: () => void }) {
  return keymap.of([
    { key: "Mod-b", run: (view) => toggleWrap(view, "**") },
    { key: "Mod-i", run: (view) => toggleWrap(view, "*") },
    {
      key: "Mod-f",
      run: () => {
        options.onFind();
        return true;
      },
    },
    ...markdownKeymap,
  ]);
}
