import { Plugin } from "prosemirror-state";
import { documentFontOf } from "./commands";

/**
 * Shows the whole-document font keys of the front matter on the editor root as
 * data attributes; the stylesheet turns them into size and family.
 */
export function scientMarkdownDocumentFontPlugin(): Plugin {
  return new Plugin({
    props: {
      attributes: (state) => {
        const { fontFamily, fontSize } = documentFontOf(state.doc);
        return {
          ...(fontSize ? { "data-scient-font-size": fontSize } : {}),
          ...(fontFamily ? { "data-scient-font-family": fontFamily } : {}),
        };
      },
    },
  });
}
