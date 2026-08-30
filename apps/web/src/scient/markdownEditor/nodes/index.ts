import type { NodeViewConstructor } from "prosemirror-view";

import { createScientCodeBlockNodeView } from "./codeBlockNodeView";
import { createScientImageNodeView, type ScientMarkdownImageSourceResolver } from "./imageNodeView";
import { createScientMathNodeView } from "./mathNodeView";
import { createScientRawBlockNodeView } from "./rawBlockNodeView";
import { createScientReferenceNodeView } from "./referenceNodeView";
import { createScientTaskListItemNodeView } from "./taskListItemNodeView";
import { createScientWikiLinkNodeView } from "./wikiLinkNodeView";

export type { ScientMarkdownImageSourceResolver } from "./imageNodeView";

export interface ScientMarkdownNodeViewOptions {
  readonly onOpenWikiLink?: (target: string) => void;
  readonly registerTaskCheckbox?: (checkbox: HTMLInputElement) => () => void;
  readonly registerWikiLink?: (link: HTMLElement) => () => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly wikiLinkSuggestions?: () => ReadonlyArray<string>;
  readonly wikiLinkTargetExists?: (target: string) => boolean | null;
}

export function buildScientMarkdownNodeViews(
  options: ScientMarkdownNodeViewOptions,
): Readonly<Record<string, NodeViewConstructor>> {
  return {
    code_block: createScientCodeBlockNodeView,
    citation: createScientReferenceNodeView,
    display_math: createScientMathNodeView,
    image: (node, view, getPos) =>
      createScientImageNodeView(node, view, getPos, options.resolveImageSource),
    inline_math: createScientMathNodeView,
    footnote_definition: createScientReferenceNodeView,
    footnote_reference: createScientReferenceNodeView,
    list_item: (node, view, getPos) =>
      createScientTaskListItemNodeView(node, view, getPos, options.registerTaskCheckbox),
    raw_block: createScientRawBlockNodeView,
    wiki_link: (node, view, getPos) =>
      createScientWikiLinkNodeView(
        node,
        view,
        getPos,
        options.onOpenWikiLink,
        options.wikiLinkSuggestions,
        options.wikiLinkTargetExists,
        options.registerWikiLink,
      ),
  };
}
