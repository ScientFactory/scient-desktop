import { describe, expect, it } from "vite-plus/test";

import { ScientMarkdownEditorView } from "./view";

describe("Scient Markdown persistent surfaces", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    _fixture.controllers.splice(0).forEach((controller) => controller.destroy());
    _clearOwnedDOM(_fixture);
    document.documentElement.classList.remove("dark");
  }

  it("keeps a code-dense document on persistent surfaces across presentation changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = Array.from(
      { length: 64 },
      (_, index) => `\`\`\`typescript\nconst value${index}: number = ${index};\n\`\`\`\n`,
    ).join("\n");
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:code-dense-performance",
      mode: "write",
      ariaLabel: "Code-dense performance qualification document",
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.controllers.push(controller);
    const view = controller.mount(host);
    const editors = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-editor"));

    expect(editors).toHaveLength(64);

    controller.setMode("read");
    expect(
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-content")).every(
        (content) => content.getAttribute("contenteditable") === "false",
      ),
    ).toBe(true);
    controller.setMode("write");
    document.documentElement.classList.add("dark");
    controller.refreshExternalPresentation("appearance");

    const editorsAfterPresentationChanges = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".cm-editor"),
    );
    expect(editorsAfterPresentationChanges).toHaveLength(editors.length);
    editorsAfterPresentationChanges.forEach((editor, index) => {
      expect(editor).toBe(editors[index]);
    });
    expect(
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-content")).every(
        (content) => content.getAttribute("contenteditable") === "true",
      ),
    ).toBe(true);
    expect(controller.session.session.draftSource).toBe(source);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    controllers: [] as ScientMarkdownEditorView[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
