import type { NodeViewConstructor } from "prosemirror-view";

import { createScientCodeBlockNodeView } from "./codeBlockNodeView";
import { createScientMathNodeView } from "./mathNodeView";
import { createScientRawBlockNodeView } from "./rawBlockNodeView";
import { createScientTaskListItemNodeView } from "./taskListItemNodeView";
import { createScientWikiLinkNodeView } from "./wikiLinkNodeView";

export const scientMarkdownNodeViews: Readonly<Record<string, NodeViewConstructor>> = {
  code_block: createScientCodeBlockNodeView,
  display_math: createScientMathNodeView,
  inline_math: createScientMathNodeView,
  list_item: createScientTaskListItemNodeView,
  raw_block: createScientRawBlockNodeView,
  wiki_link: createScientWikiLinkNodeView,
};
