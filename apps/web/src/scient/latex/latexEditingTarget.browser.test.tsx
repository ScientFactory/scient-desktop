import { render as _fixtureRender } from "../../../test/render";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { useLayoutEffect } from "react";

import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import {
  activateLatexEditingTarget,
  clearLatexEditingTarget,
  latexEditingTarget,
  useLatexEditingPresentation,
} from "./latexEditingTarget";

it("native typing leaves unchanged controls alone while selection, formatting and editability remain live", async () => {
  await using _fixture = _createFixture();

  const host = document.createElement("div");
  const paper = document.createElement("div");
  paper.dataset.presentationPaper = "";
  document.body.append(host, paper);
  const editor = new Editor({
    element: paper,
    extensions: [StarterKit],
    content: "<p>Original text.</p>",
  });
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  let renders = 0;
  function Toolbar() {
    const state = useLatexEditingPresentation(editor);
    useLayoutEffect(() => {
      renders += 1;
    });
    return (
      <>
        <output data-presentation="">
          {JSON.stringify(state, (key, value) => (key === "editor" ? undefined : value))}
        </output>
        <button type="button" onClick={() => latexEditingTarget(editor).commands.toggleBold()}>
          Toggle live bold
        </button>
      </>
    );
  }
  const presentation = () => JSON.parse(host.querySelector("output")!.textContent!);
  try {
    await root.rerender(<Toolbar />);
    await expect
      .poll(() => host.querySelector("output")?.textContent)
      .toContain('"formattingAvailable":true');
    editor.commands.focus("end");
    await userEvent.click(page.elementLocator(editor.view.dom));
    editor.commands.focus("end");
    const beforeTyping = renders;
    await userEvent.keyboard(" Smooth typing");
    expect(editor.state.doc.textContent).toBe("Original text. Smooth typing");
    expect(presentation().selectedWords).toBeNull();
    expect(renders).toBe(beforeTyping);
    editor.commands.setTextSelection({ from: 1, to: 14 });
    await expect.poll(() => presentation().selectedWords).toBe(2);
    await userEvent.click(page.getByRole("button", { name: "Toggle live bold" }));
    await expect.poll(() => presentation().bold).toBe(true);
    expect(editor.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toContain(
      "bold",
    );
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    await expect.poll(() => presentation().selectedWords).toBeNull();
    editor.commands.toggleItalic();
    await expect.poll(() => presentation().italic).toBe(true);
    editor.commands.toggleCode();
    await expect.poll(() => presentation().code).toBe(true);
    const stateBeforeEditability = editor.state;
    editor.setEditable(false);
    expect(editor.state).toBe(stateBeforeEditability);
    await expect.poll(() => presentation().formattingAvailable).toBe(false);
    editor.setEditable(true);
    await expect.poll(() => presentation().formattingAvailable).toBe(true);
  } finally {
    await root.unmount();
    editor.destroy();
    host.remove();
    paper.remove();
  }
});

it("presentation follows inline ownership and commands without waiting for a transaction", async () => {
  await using _fixture = _createFixture();

  const host = document.createElement("div");
  const paper = document.createElement("div");
  const fieldPaper = document.createElement("div");
  document.body.append(host, paper, fieldPaper);
  const owner = new Editor({
    element: paper,
    extensions: [StarterKit],
    content: "<p>Body text.</p>",
  });
  const field = new Editor({
    element: fieldPaper,
    extensions: [StarterKit],
    content: "<p><em>Caption text.</em></p>",
  });
  field.commands.setTextSelection({ from: 1, to: 8 });
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  let renderedEditor: Editor | null = null;
  function Toolbar({ editor }: { editor: Editor | null }) {
    const state = useLatexEditingPresentation(editor);
    useLayoutEffect(() => {
      renderedEditor = state.editor;
    });
    return <output>{`${state.italic}|${state.selectedWords}|${state.formattingAvailable}`}</output>;
  }
  try {
    await root.rerender(<Toolbar editor={null} />);
    await expect.poll(() => host.textContent).toBe("false|null|false");
    await root.rerender(<Toolbar editor={owner} />);
    await expect.poll(() => renderedEditor).toBe(owner);
    field.commands.focus();
    activateLatexEditingTarget(owner, field);
    await expect.poll(() => renderedEditor).toBe(field);
    expect(host.textContent).toBe("true|1|true");
    latexEditingTarget(owner).commands.insertContent("Updated");
    expect(field.state.doc.textContent).toBe("Updated text.");
    expect(owner.state.doc.textContent).toBe("Body text.");
    clearLatexEditingTarget(owner, field);
    await expect.poll(() => renderedEditor).toBe(owner);
    expect(host.textContent).toBe("false|null|true");
  } finally {
    await root.unmount();
    clearLatexEditingTarget(owner);
    field.destroy();
    owner.destroy();
    host.remove();
    paper.remove();
    fieldPaper.remove();
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
