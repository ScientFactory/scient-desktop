import { render as _fixtureRender, type Screen } from "../../../test/render";

import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import type { MathfieldElement } from "mathlive";
import { LatexMathField } from "./LatexMathField";
import { LatexDocumentMathContext } from "./LatexDocumentMathContext";
import { latexDocumentMathSetup } from "./latexDocumentMacros";

const publish = vi.fn();
const spokenLabel = (math: MathfieldElement) =>
  math.shadowRoot?.querySelector(".ML__keyboard-sink")?.getAttribute("aria-label");

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  publish.mockReset();
}

async function mount(_fixture: _Fixture, value: string, display = false) {
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText = "width:800px;min-height:250px";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  function Harness() {
    const [source, setSource] = useState(value);
    const [macroDefinition, setMacroDefinition] = useState("x");
    const macros = latexDocumentMathSetup(
      `\\documentclass{article}\n\\newcommand{\\reviewmacro}{${macroDefinition}}\n\\begin{document}`,
    ).macros;
    return (
      <LatexDocumentMathContext.Provider value={macros}>
        <textarea
          aria-label="Synthetic formula source"
          value={source}
          onChange={(event) => setSource(event.currentTarget.value)}
        />
        <input
          aria-label="Synthetic macro definition"
          value={macroDefinition}
          onChange={(event) => setMacroDefinition(event.currentTarget.value)}
        />
        <LatexMathField
          value={source}
          display={display}
          editing
          disabled={false}
          onChange={(next) => {
            publish(next);
            setSource(next);
            return { accepted: true, value: next };
          }}
          onFocus={() => {}}
          onExit={() => {}}
          onExtendOutside={() => false}
          onUndo={() => false}
          onRemoveEmpty={() => false}
          onShortcut={() => false}
          onShortcutHint={() => {}}
          formatCopiedMath={(tex) => tex}
          parsePastedMath={() => null}
        />
      </LatexDocumentMathContext.Provider>
    );
  }
  await _fixture.root0.rerender(<Harness />);
  await expect.poll(() => _fixture.host.querySelector("math-field")).toBeTruthy();
  const math = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  math.focus();
  await expect.poll(() => document.activeElement === math).toBe(true);
  await expect.poll(() => spokenLabel(math)).toBeTruthy();
  return { math, source: _fixture.host.querySelector<HTMLTextAreaElement>("textarea")! };
}

it.each([
  { before: "E=mc^2", after: "E=mc^3", newWord: "cubed", display: false },
  { before: "\\frac{1}{3}", after: "\\frac{1}{4}", newWord: "quarter", display: true },
])(
  "refreshes $newWord after a source edit without publishing or moving focus",
  async (scenario) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { math, source } = await mount(_fixture, scenario.before, scenario.display);
    await userEvent.fill(source, scenario.after);
    await expect.poll(() => math.getValue("latex")).toBe(scenario.after);
    await expect.poll(() => spokenLabel(math)).toContain(scenario.newWord);
    expect(document.activeElement).toBe(source);
    expect(publish).not.toHaveBeenCalled();
  },
);

it("keeps the spoken label current through undo/redo source revisions", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { math, source } = await mount(_fixture, "E=mc^2");
  for (const { value, word } of [
    { value: "E=mc^3", word: "cubed" },
    { value: "E=mc^2", word: "squared" },
    { value: "E=mc^3", word: "cubed" },
  ]) {
    await userEvent.fill(source, value);
    await expect.poll(() => spokenLabel(math)).toContain(word);
    expect(document.activeElement).toBe(source);
  }
  expect(publish).not.toHaveBeenCalled();
});

it("refreshes the spoken label during live keyboard editing", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { math } = await mount(_fixture, "x");
  math.position = math.lastOffset;
  await userEvent.keyboard("+1");
  await expect.poll(() => math.getValue("latex")).toBe("x+1");
  await expect.poll(() => spokenLabel(math)).toBe(math.getValue("spoken-text"));
  expect(math.hasFocus()).toBe(true);
  await expect.poll(() => publish.mock.calls.length).toBe(1);
});

it("preserves document macros during source and macro updates without moving focus", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { math, source } = await mount(_fixture, "\\reviewmacro");
  const rendered = () => math.shadowRoot?.querySelector(".ML__content")?.textContent;
  await expect.poll(rendered).toContain("x");
  await userEvent.fill(source, "\\reviewmacro^3");
  await expect.poll(() => spokenLabel(math)).toContain("cubed");
  const definition = _fixture.host.querySelector<HTMLInputElement>(
    'input[aria-label="Synthetic macro definition"]',
  )!;
  await userEvent.fill(definition, "y");
  await expect.poll(rendered).toContain("y");
  expect(spokenLabel(math)).toBe(math.getValue("spoken-text"));
  expect(math.getValue("latex")).toBe("\\reviewmacro^3");
  expect(document.activeElement).toBe(definition);
  expect(publish).not.toHaveBeenCalled();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
