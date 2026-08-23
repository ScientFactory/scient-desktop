import type { NodeViewConstructor } from "prosemirror-view";

import { createScientCodeBlockNodeView } from "./codeBlockNodeView";
import { createScientImageNodeView, type ScientMarkdownImageSourceResolver } from "./imageNodeView";
import { createScientMathNodeView } from "./mathNodeView";
import { createScientRawBlockNodeView } from "./rawBlockNodeView";
import { createScientTaskListItemNodeView } from "./taskListItemNodeView";
import { createScientWikiLinkNodeView } from "./wikiLinkNodeView";

export type { ScientMarkdownImageSourceResolver } from "./imageNodeView";

export interface ScientMarkdownNodeViewOptions {
  readonly onOpenWikiLink?: (target: string) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
}

export function buildScientMarkdownNodeViews(
  options: ScientMarkdownNodeViewOptions,
): Readonly<Record<string, NodeViewConstructor>> {
  return {
    code_block: createScientCodeBlockNodeView,
    display_math: createScientMathNodeView,
    image: (node, view, getPos) =>
      createScientImageNodeView(node, view, getPos, options.resolveImageSource),
    inline_math: createScientMathNodeView,
    list_item: createScientTaskListItemNodeView,
    raw_block: createScientRawBlockNodeView,
    wiki_link: (node, view, getPos) =>
      createScientWikiLinkNodeView(node, view, getPos, options.onOpenWikiLink),
  };
}
