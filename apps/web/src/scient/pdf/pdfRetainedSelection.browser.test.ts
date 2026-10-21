import { expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { installPdfRetainedSelection } from "./pdfRetainedSelection";

async function _cleanupFixture0(_fixture: _Fixture) {
  _fixture.stop?.();
  _fixture.root?.remove();
  document.getSelection()?.removeAllRanges();
}

it("retains the selected PDF word while Source has its own native selection", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  _fixture.root = document.createElement("div");
  _fixture.root.dataset.latexSplit = "true";
  const pdf = document.createElement("div");
  const layer = document.createElement("div");
  const word = document.createElement("span");
  layer.className = "textLayer";
  word.textContent = "chosen";
  layer.append(word);
  pdf.append(layer);
  const source = document.createElement("div");
  source.contentEditable = "true";
  source.textContent = "different";
  _fixture.root.append(pdf, source);
  document.body.append(_fixture.root);
  _fixture.stop = installPdfRetainedSelection(pdf);
  await userEvent.dblClick(word);
  expect(document.getSelection()?.toString()).toBe("chosen");
  await userEvent.dblClick(source);
  expect(document.getSelection()?.toString()).toBe("different");
  const highlight = [...CSS.highlights.entries()].find(([name]) =>
    name.startsWith("scient-pdf-retained-"),
  );
  expect(highlight).toBeTruthy();
  expect([...highlight![1]][0]!.toString()).toBe("chosen");
  await userEvent.click(word);
  expect(CSS.highlights.has(highlight![0])).toBe(false);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stop: undefined! as () => void,

    root: undefined! as HTMLElement,
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
