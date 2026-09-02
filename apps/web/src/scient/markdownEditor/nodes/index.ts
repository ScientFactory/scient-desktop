import type { NodeViewConstructor } from "prosemirror-view";

import type { ScientRichFenceContextMenuHandler } from "~/scient/presentation/RichFenceSourceActions";

import type { ScientMarkdownLinkOpenHandler } from "../linkOpen";
import { createScientCodeBlockNodeView } from "./codeBlockNodeView";
import type {
  ScientMarkdownExternalPresentationRegistrar,
  ScientMarkdownThemeResolver,
} from "./externalPresentation";
import { createScientImageNodeView, type ScientMarkdownImageSourceResolver } from "./imageNodeView";
import { createScientMathNodeView } from "./mathNodeView";
import {
  createScientRawBlockNodeView,
  type ScientMarkdownRawSourceEditorRegistrar,
} from "./rawBlockNodeView";
import {
  createScientReferenceNodeView,
  type ScientMarkdownFootnoteNodeViewRegistrar,
} from "./referenceNodeView";
import { createScientTaskListItemNodeView } from "./taskListItemNodeView";
import { createScientWikiLinkNodeView } from "./wikiLinkNodeView";

export type { ScientMarkdownImageSourceResolver } from "./imageNodeView";
export type { ScientMarkdownFootnoteNodeViewRegistration } from "./referenceNodeView";
export type {
  ScientMarkdownExternalPresentationChange,
  ScientMarkdownExternalPresentationRefresh,
  ScientMarkdownExternalPresentationRegistrar,
  ScientMarkdownTheme,
} from "./externalPresentation";

export interface ScientMarkdownNodeViewOptions {
  readonly onOpenWikiLink?: ScientMarkdownLinkOpenHandler;
  readonly registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar;
  readonly registerFootnote?: ScientMarkdownFootnoteNodeViewRegistrar;
  readonly registerRawSourceEditor?: ScientMarkdownRawSourceEditorRegistrar;
  readonly registerTaskCheckbox?: (checkbox: HTMLInputElement) => () => void;
  readonly registerWikiLink?: (link: HTMLElement, getPos: () => number | undefined) => () => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly resolveTheme?: ScientMarkdownThemeResolver;
  readonly showRichFenceContextMenu?: ScientRichFenceContextMenuHandler;
  readonly wikiLinkTargetExists?: (target: string) => boolean | null;
}

export function buildScientMarkdownNodeViews(
  options: ScientMarkdownNodeViewOptions,
): Readonly<Record<string, NodeViewConstructor>> {
  return {
    code_block: (node, view, getPos) =>
      createScientCodeBlockNodeView(
        node,
        view,
        getPos,
        options.resolveTheme,
        options.registerExternalPresentation,
        options.showRichFenceContextMenu,
      ),
    citation: (node, view, getPos) => createScientReferenceNodeView(node, view, getPos),
    display_math: createScientMathNodeView,
    image: (node, view, getPos) =>
      createScientImageNodeView(
        node,
        view,
        getPos,
        options.resolveImageSource,
        options.registerExternalPresentation,
      ),
    inline_math: createScientMathNodeView,
    footnote_definition: (node, view, getPos) =>
      createScientReferenceNodeView(node, view, getPos, options.registerFootnote),
    footnote_reference: (node, view, getPos) =>
      createScientReferenceNodeView(node, view, getPos, options.registerFootnote),
    list_item: (node, view, getPos) =>
      createScientTaskListItemNodeView(node, view, getPos, options.registerTaskCheckbox),
    raw_block: (node, view, getPos) =>
      createScientRawBlockNodeView(node, view, getPos, options.registerRawSourceEditor),
    wiki_link: (node, view, getPos) =>
      createScientWikiLinkNodeView(
        node,
        view,
        getPos,
        options.onOpenWikiLink,
        options.wikiLinkTargetExists,
        options.registerWikiLink,
        options.registerExternalPresentation,
      ),
  };
}
