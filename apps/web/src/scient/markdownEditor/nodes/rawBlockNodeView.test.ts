// @vitest-environment happy-dom
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { scientMarkdownSchema } from "../prosemirror/schema";
import { createScientRawBlockNodeView } from "./rawBlockNodeView";

describe("raw Markdown source islands", () => {
  afterEach(() => document.body.replaceChildren());

  it.each([
    ["yaml", "---\ntitle: Native Markdown acceptance\n---"],
    ["html", "<!-- Keep this exact comment. -->"],
  ])("swaps the %s preview for one source editor while selected", (sourceKind, source) => {
    const node = scientMarkdownSchema.nodes.raw_block!.create({ source, sourceKind });
    const nodeView = createScientRawBlockNodeView(node, {} as EditorView, () => 0);
    document.body.append(nodeView.dom);

    const preview = nodeView.dom.querySelector<HTMLElement>(
      ".scient-markdown-source-island-preview",
    )!;
    const editor = nodeView.dom.querySelector<HTMLTextAreaElement>(
      ".scient-markdown-source-island-editor",
    )!;

    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toBe(source);
    expect(editor.hidden).toBe(true);

    nodeView.selectNode?.();
    expect(preview.hidden).toBe(true);
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe(source);

    nodeView.deselectNode?.();
    expect(preview.hidden).toBe(false);
    expect(editor.hidden).toBe(true);

    nodeView.destroy?.();
  });
});
