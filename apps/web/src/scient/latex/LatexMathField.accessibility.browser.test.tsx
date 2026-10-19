import { createRoot, type Root } from "react-dom/client";
import { useMemo, useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import type { MathfieldElement } from "mathlive";
import { LatexMathField } from "./LatexMathField";
import { LatexDocumentMathContext } from "./LatexDocumentMathContext";
import { latexDocumentMathSetup } from "./latexDocumentMacros";

let host: HTMLDivElement;
let root: Root;
const publish = vi.fn();
const spokenLabel = (math: MathfieldElement) =>
  math.shadowRoot?.querySelector(".ML__keyboard-sink")?.getAttribute("aria-label");

afterEach(() => {
  root?.unmount();
  host?.remove();
  publish.mockReset();
});

async function mount(value: string, display = false) {
  host = document.createElement("div");
  host.style.cssText = "width:800px;min-height:250px";
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const [source, setSource] = useState(value);
    const [macroDefinition, setMacroDefinition] = useState("x");
    const macros = useMemo(
      () =>
        latexDocumentMathSetup(
          `\\documentclass{article}\n\\newcommand{\\reviewmacro}{${macroDefinition}}\n\\begin{document}`,
        ).macros,
      [macroDefinition],
    );
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
  root.render(<Harness />);
  await expect.poll(() => host.querySelector("math-field")).toBeTruthy();
  const math = host.querySelector<MathfieldElement>("math-field")!;
  math.focus();
  await expect.poll(() => document.activeElement === math).toBe(true);
  await expect.poll(() => spokenLabel(math)).toBeTruthy();
  return { math, source: host.querySelector<HTMLTextAreaElement>("textarea")! };
}

it.each([
  { before: "E=mc^2", after: "E=mc^3", newWord: "cubed", display: false },
  { before: "\\frac{1}{3}", after: "\\frac{1}{4}", newWord: "quarter", display: true },
])(
  "refreshes $newWord after a source edit without publishing or moving focus",
  async (scenario) => {
    const { math, source } = await mount(scenario.before, scenario.display);
    await userEvent.fill(source, scenario.after);
    await expect.poll(() => math.getValue("latex")).toBe(scenario.after);
    await expect.poll(() => spokenLabel(math)).toContain(scenario.newWord);
    expect(document.activeElement).toBe(source);
    expect(publish).not.toHaveBeenCalled();
  },
);

it("keeps the spoken label current through undo/redo source revisions", async () => {
  const { math, source } = await mount("E=mc^2");
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
  const { math } = await mount("x");
  math.position = math.lastOffset;
  await userEvent.keyboard("+1");
  await expect.poll(() => math.getValue("latex")).toBe("x+1");
  await expect.poll(() => spokenLabel(math)).toBe(math.getValue("spoken-text"));
  expect(math.hasFocus()).toBe(true);
  await expect.poll(() => publish.mock.calls.length).toBe(1);
});

it("preserves document macros during source and macro updates without moving focus", async () => {
  const { math, source } = await mount("\\reviewmacro");
  const rendered = () => math.shadowRoot?.querySelector(".ML__content")?.textContent;
  await expect.poll(rendered).toContain("x");
  await userEvent.fill(source, "\\reviewmacro^3");
  await expect.poll(() => spokenLabel(math)).toContain("cubed");
  const definition = host.querySelector<HTMLInputElement>(
    'input[aria-label="Synthetic macro definition"]',
  )!;
  await userEvent.fill(definition, "y");
  await expect.poll(rendered).toContain("y");
  expect(spokenLabel(math)).toBe(math.getValue("spoken-text"));
  expect(math.getValue("latex")).toBe("\\reviewmacro^3");
  expect(document.activeElement).toBe(definition);
  expect(publish).not.toHaveBeenCalled();
});
