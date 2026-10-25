import { describe, expect, it } from "vite-plus/test";

import { chatMarkdownClipboardPayload } from "./markdown-clipboard";

function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("copying rendered math", () => {
  // regression: cb0553ea39 feat(markdown): render LaTeX across web and native mobile (#18735)
  it("copies a formula's TeX whether the selection spans it or starts inside it", async () => {
    await using _fixture = _createFixture();

    _ownedBody(_fixture).innerHTML =
      `<div class="chat-markdown"><p>Area <span data-markdown-math="" data-markdown-copy="$\\pi r^2$"><span class="katex"><span class="katex-mathml">πr2</span><span class="katex-html" aria-hidden="true">πr2</span></span></span> grows.</p></div>`;
    const paragraph = document.querySelector("p")!;
    const glyphs = document.querySelector(".katex-mathml")!.firstChild!;

    expect(
      chatMarkdownClipboardPayload(select(paragraph.firstChild!, 0, paragraph.lastChild!, 7))?.text,
    ).toBe("Area $\\pi r^2$ grows.");
    expect(chatMarkdownClipboardPayload(select(glyphs, 0, glyphs, 1))?.text).toBe("$\\pi r^2$");
  });
});

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _ownedBody(_fixture: _Fixture) {
  const element = _ownDOM(_fixture, document.createElement("div"));
  document.body.append(element);
  return element;
}

function _createFixture() {
  const stack = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
