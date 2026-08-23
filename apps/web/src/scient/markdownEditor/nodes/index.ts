import type { NodeViewConstructor } from "prosemirror-view";

import { createScientMathNodeView } from "./mathNodeView";

export const scientMarkdownNodeViews: Readonly<Record<string, NodeViewConstructor>> = {
  display_math: createScientMathNodeView,
  inline_math: createScientMathNodeView,
};
