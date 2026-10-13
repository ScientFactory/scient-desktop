import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { isMacKeyboard } from "../keyboard/keys";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

let root: Root | undefined;
let host: HTMLDivElement;
let source = "";
let edits = 0;
const draftKey = "clipboard-regression";
const document = (body: string) =>
  `\\documentclass{article}\n\\usepackage{amsmath,hyperref,natbib}\n\\begin{document}\n${body}\n\\end{document}`;

afterEach(() => {
  root?.unmount();
  root = undefined;
  host?.remove();
  clearVisualDraft(draftKey);
});

async function mount(body: string, disabled = false) {
  await page.viewport(1300, 900);
  source = document(body);
  edits = 0;
  clearVisualDraft(draftKey);
  host = window.document.createElement("div");
  host.style.cssText = "width:1100px;height:850px";
  window.document.body.append(host);
  root = createRoot(host);
  const initial = source;
  function Harness() {
    const [text, setText] = useState(initial);
    const owner = useLatexVisualTestOwner(text);
    return (
      <LatexVisualEditor
        sourceSnapshot={owner.snapshot}
        source={text}
        draftKey={draftKey}
        fileRevision="r1"
        disabled={disabled}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const result = owner.edit(request);
          if (result.accepted) {
            edits++;
            source = result.snapshot.source;
            setText(source);
          }
          return result;
        }}
      />
    );
  }
  root.render(<Harness />);
  await expect
    .poll(
      () =>
        host.querySelector<HTMLElement & { editor: Editor }>(".scient-latex-visual-document")
          ?.editor,
    )
    .toBeTruthy();
  const editor = host.querySelector<HTMLElement & { editor: Editor }>(
    ".scient-latex-visual-document",
  )!.editor;
  await expect
    .poll(() => editor.view.dom.getAttribute("data-latex-opening"), { timeout: 15000 })
    .toBe("false");
  return editor;
}

function clipboard(editor: Editor, type: "copy" | "cut" | "paste", data = new DataTransfer()) {
  editor.view.dom.dispatchEvent(
    new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }),
  );
  return data;
}

function selectCommand(editor: Editor) {
  let found: number | null = null;
  editor.state.doc.descendants((node, position) => {
    if (found === null && node.type.name === "latexInlineCommand") found = position;
  });
  expect(found).not.toBeNull();
  editor.view.dispatch(
    editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, found!)),
  );
}

it.each([
  String.raw`\ref{sec:one}`,
  String.raw`\citep[see][p.~7]{alpha,beta}`,
  String.raw`\href{https://example.test}{Read this}`,
  String.raw`\footnote{Footnote text.}`,
  String.raw`\protect \ref{sec:one}`,
])("copies a selected command through the real editor event: %s", async (command) => {
  const editor = await mount(command);
  const original = source;
  const undo = editor.can().undo();
  selectCommand(editor);
  const transfer = clipboard(editor, "copy");
  expect(transfer.getData("text/plain")).toBe(command);
  expect(transfer.getData("text/html")).toContain("data-pm-slice");
  expect(source).toBe(original);
  expect(edits).toBe(0);
  expect(editor.can().undo()).toBe(undo);
});

it("copies and pastes mixed commands, escaping and Hebrew, then undoes and reopens exact source", async () => {
  const body = String.raw`לפני 50\% \ref{sec:one} \citep[see][p.~7]{alpha,beta} \href{https://example.test}{Read this} \footnote{Footnote text.} אחרי.`;
  const editor = await mount(body + "\n\nDestination.");
  const original = source;
  editor.commands.setTextSelection({ from: 1, to: editor.state.doc.firstChild!.nodeSize - 1 });
  const transfer = clipboard(editor, "copy");
  expect(transfer.getData("text/plain")).toBe(body);
  expect(source).toBe(original);
  expect(edits).toBe(0);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  clipboard(editor, "paste", transfer);
  await expect.poll(() => source).not.toBe(original);
  expect(source.match(/\\ref\{sec:one\}/gu)).toHaveLength(2);
  expect(source.match(/\\citep\[see\]\[p\.~7\]\{alpha,beta\}/gu)).toHaveLength(2);
  expect(source.match(/\\href\{https:\/\/example\.test\}\{Read this\}/gu)).toHaveLength(2);
  expect(source.match(/\\footnote\{Footnote text\.\}/gu)).toHaveLength(2);
  editor.commands.undo();
  await expect.poll(() => source).toBe(original);
  root?.unmount();
  root = undefined;
  host.remove();
  const reopened = await mount(body + "\n\nDestination.");
  expect(source).toBe(original);
  reopened.commands.setTextSelection({ from: 1, to: reopened.state.doc.firstChild!.nodeSize - 1 });
  expect(clipboard(reopened, "copy").getData("text/plain")).toBe(body);
}, 45000);

it("cuts the selected command to the clipboard and undo restores exact source", async () => {
  const editor = await mount(String.raw`Before \ref{sec:one} after.`);
  const original = source;
  selectCommand(editor);
  expect(clipboard(editor, "cut").getData("text/plain")).toBe(String.raw`\ref{sec:one}`);
  await expect.poll(() => source).not.toBe(original);
  expect(source).not.toContain(String.raw`\ref{sec:one}`);
  editor.commands.undo();
  await expect.poll(() => source).toBe(original);
});

it("uses browser Copy and Cut shortcuts and restores source with keyboard Undo", async () => {
  const editor = await mount(String.raw`Before \ref{sec:one} after.`);
  const original = source;
  const copied: string[] = [];
  const cut: string[] = [];
  host.addEventListener("copy", (event) =>
    copied.push(event.clipboardData?.getData("text/plain") ?? ""),
  );
  host.addEventListener("cut", (event) =>
    cut.push(event.clipboardData?.getData("text/plain") ?? ""),
  );
  editor.commands.focus(undefined, { scrollIntoView: false });
  selectCommand(editor);
  await expect.poll(() => editor.view.hasFocus()).toBe(true);
  await userEvent.keyboard(isMacKeyboard() ? "{Meta>}c{/Meta}" : "{Control>}c{/Control}");
  expect(copied).toEqual([String.raw`\ref{sec:one}`]);
  expect(source).toBe(original);
  expect(edits).toBe(0);
  await userEvent.keyboard(isMacKeyboard() ? "{Meta>}x{/Meta}" : "{Control>}x{/Control}");
  expect(cut).toEqual([String.raw`\ref{sec:one}`]);
  await expect.poll(() => source).not.toBe(original);
  await userEvent.keyboard(isMacKeyboard() ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}");
  await expect.poll(() => source).toBe(original);
});

it("copies a nested open selection without copying its unselected text", async () => {
  const editor = await mount(String.raw`\begin{quote}Before \ref{sec:one} after.\end{quote}`);
  const original = source;
  let position: number | null = null;
  editor.state.doc.descendants((node, at) => {
    if (node.type.name === "latexInlineCommand") position = at;
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position!, position! + 1)),
  );
  const copied = clipboard(editor, "copy").getData("text/plain");
  expect(copied).toContain(String.raw`\ref{sec:one}`);
  expect(copied).not.toContain("Before");
  expect(copied).not.toContain("after");
  expect(source).toBe(original);
  expect(edits).toBe(0);
});

it("preserves existing formula and table copy events", async () => {
  const table = String.raw`\begin{tabular}{ll}A & B \\ C & D\end{tabular}`;
  const editor = await mount("$x+1$\n\n" + table);
  const original = source;
  const nodes: { position: number; type: string }[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "latexInlineMath" || node.attrs.kind === "table")
      nodes.push({ position, type: node.type.name });
  });
  expect(nodes).toHaveLength(2);
  for (const node of nodes) {
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, node.position)),
    );
    const transfer = clipboard(editor, "copy");
    expect(transfer.getData("text/plain")).toBe(node.type === "latexInlineMath" ? "$x+1$" : table);
    if (node.type === "latexInlineMath")
      expect(transfer.getData("application/x-latex")).toBe("$x+1$");
  }
  expect(source).toBe(original);
  expect(edits).toBe(0);
});

it("copies read-only source without enabling cut or paste", async () => {
  const editor = await mount(String.raw`Before \ref{sec:one} after.`, true);
  const original = source;
  selectCommand(editor);
  expect(clipboard(editor, "copy").getData("text/plain")).toBe(String.raw`\ref{sec:one}`);
  clipboard(editor, "cut");
  const transfer = new DataTransfer();
  transfer.setData("text/plain", String.raw`\cite{other}`);
  clipboard(editor, "paste", transfer);
  expect(source).toBe(original);
  expect(edits).toBe(0);
});

it("stress-tests thirty mixed-command copy/paste/undo cycles without source drift", async () => {
  const body = String.raw`שלום \ref{sec:one} \citep[see][p.~7]{alpha,beta} \href{https://example.test}{Link} \footnote{Note} סוף.`;
  const editor = await mount(body + "\n\nDestination.");
  const original = source;
  for (let round = 0; round < 30; round++) {
    const before = edits;
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.firstChild!.nodeSize - 1 });
    const transfer = clipboard(editor, "copy");
    expect(transfer.getData("text/plain")).toBe(body);
    expect(edits).toBe(before);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    clipboard(editor, "paste", transfer);
    await expect.poll(() => source).not.toBe(original);
    expect(source.match(/\\ref\{sec:one\}/gu)).toHaveLength(2);
    editor.commands.undo();
    await expect.poll(() => source).toBe(original);
  }
}, 60000);
