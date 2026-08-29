import { markdownKeymap } from "@codemirror/lang-markdown";
import { EditorSelection } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";

function toggleWrap(marker: string): Command {
  return (view) => {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
        const unwrapped = text.slice(marker.length, text.length - marker.length);
        return {
          changes: { from: range.from, to: range.to, insert: unwrapped },
          range: EditorSelection.range(range.from, range.from + unwrapped.length),
        };
      }
      return {
        changes: { from: range.from, to: range.to, insert: `${marker}${text}${marker}` },
        range: EditorSelection.range(
          range.from + marker.length,
          range.from + marker.length + text.length,
        ),
      };
    });
    view.dispatch(changes);
    return true;
  };
}

/** Markdown editing keymap: formatting toggles plus lang-markdown's list continuation. */
export const markdownEditingKeymap = keymap.of([
  { key: "Mod-b", run: toggleWrap("**") },
  { key: "Mod-i", run: toggleWrap("*") },
  ...markdownKeymap,
]);
