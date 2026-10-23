import { render as _fixtureRender } from "../../../test/render";
import type { ReactNode } from "react";

import { Editor, Extension, Node } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { LatexDirectionMenuItems } from "./LatexDirectionMenuItems";
import { TextMenu } from "../writing/TextMenu";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";
import "~/index.css";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));

const sourceAttributes = Extension.create({
  name: "directionSourceAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: { sourceId: { default: null }, latexNoIndent: { default: false } },
      },
    ];
  },
});
const scientific = Node.create({
  name: "latexScientific",
  group: "block",
  content: "block+",
  addAttributes() {
    return {
      environment: { default: "" },
      title: { default: "" },
      raw: { default: "" },
      titleSource: { default: null },
      titleRemoved: { default: false },
      sourceId: { default: null },
      layout: { default: null },
      layoutGap: { default: null },
    };
  },
  renderHTML({ node }) {
    return ["div", { dir: node.attrs.layout?.direction }, 0];
  },
});
const math = Node.create({
  name: "latexInlineMath",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { tex: { default: "" }, wrapper: { default: "paren" } };
  },
  renderHTML({ node }) {
    return ["span", {}, String(node.attrs.tex)];
  },
});

it("enables a compact direction menu in a plain English document and saves a working override", async () => {
  await using _fixture = _createFixture();

  await page.viewport(1200, 800);
  const host = document.createElement("div");
  document.body.append(host);
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  let source =
    "\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\nText \\textbf{bold} $x^2$.\n\nNeighbour.\n\\end{document}\n";
  let projection = projectLatexVisualDocument(source);
  let writes = 0;
  const editor = new Editor({
    extensions: [StarterKit, sourceAttributes, scientific, math],
    content: projection.content,
    onUpdate: async ({ editor: owner }) => {
      const result = applyLatexVisualDocumentChange(source, projection, owner.getJSON());
      if (!result) throw new Error("The direction command could not save its source.");
      source = result.source;
      projection = result.projection;
      writes++;
      await render();
    },
  });
  const render = async () =>
    await root.rerender(
      <>
        <TextMenu
          paragraphStyle={null}
          formatting={null}
          commandScope="latex"
          direction={
            <LatexDirectionMenuItems
              editor={editor}
              disabled={false}
              setup={source}
              getSource={() => source}
            />
          }
        />
        <EditorContent editor={editor} />
      </>,
    );
  try {
    await render();
    await expect.poll(() => host.querySelector(".ProseMirror")).toBeTruthy();
    editor.commands.setTextSelection(3);
    editor.commands.focus();
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.getByRole("menuitem", { name: "Direction", exact: true }).click();
    const rtl = page.getByRole("menuitemradio", { name: "Right to left", exact: true });
    await expect.element(rtl).toBeEnabled();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Left to right", exact: true }))
      .toBeEnabled();
    const row = document.querySelector('[role="menuitemradio"][aria-label="Right to left"]')!;
    const popup = row.closest('[data-slot="menu-sub-content"]')!;
    expect(popup.getBoundingClientRect().width).toBeLessThan(160);
    expect(row.querySelector("svg")!.getBoundingClientRect().width).toBe(14);
    await rtl.click();
    await expect.poll(() => writes).toBe(1);
    expect(source).toContain("\\begin{RTL}\nText \\textbf{bold} $x^2$.\n\\end{RTL}");
    expect(source).toContain("\\usepackage{hyperref}\n\\usepackage{bidi}");
    expect(source).toMatch(/^% !TEX program = xelatex\n/u);
    expect(getComputedStyle(host.querySelector('[dir="rtl"] p')!).direction).toBe("rtl");
    expect(host.querySelector(".ProseMirror > p")?.textContent).toBe("Neighbour.");
    expect(editor.commands.undo()).toBe(true);
    await expect.poll(() => source.includes("\\begin{RTL}")).toBe(false);
    expect(editor.commands.redo()).toBe(true);
    await expect.poll(() => source.includes("\\begin{RTL}")).toBe(true);
    expect(source.match(/\\usepackage\{bidi\}/gu)).toHaveLength(1);
  } finally {
    await root.unmount();
    editor.destroy();
    host.remove();
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
