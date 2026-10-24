import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";

// SCIENT-FORK:START — contextual policy stays behind the inherited PM presentation API.
import type { ContentDirection, FixedContentDirection } from "~/scient/bidi/contentDirection";
import { composerTextDirections } from "~/scient/bidi/composerTextDirections";
export { composerTextDirections };
export const composerContentDirectionKey = new PluginKey<ContentDirection>(
  "composer-text-direction",
);
// SCIENT-FORK:END

export function caretLineDirection(state: EditorState): FixedContentDirection | null {
  return (
    // SCIENT-FORK:START — the caret follows the same preference as block decorations.
    composerTextDirections(state.doc, composerContentDirectionKey.getState(state) ?? "auto").blocks[
      state.selection.$head.index(0)
    ] ?? null
    // SCIENT-FORK:END
  );
}

export const ComposerTextDirectionExtension = Extension.create({
  name: "composer-text-direction",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        // SCIENT-FORK:START — preference is transaction state, not a second document authority.
        key: composerContentDirectionKey,
        state: {
          init: () => "auto" as ContentDirection,
          apply: (transaction, current) =>
            transaction.getMeta(composerContentDirectionKey) ?? current,
        },
        // SCIENT-FORK:END
        props: {
          // SCIENT-FORK:START — delegate the block policy without adding an async boundary.
          decorations: (state) =>
            composerTextDirections(state.doc, composerContentDirectionKey.getState(state) ?? "auto")
              .decorations,
          // SCIENT-FORK:END
          // On Chrome, ProseMirror reads the arrow keys' direction from the
          // editor root, so the root follows the line holding the caret.
          attributes: (state): Record<string, string> => {
            const dir = caretLineDirection(state);
            return dir ? { dir } : {};
          },
        },
      }),
    ];
  },
});
