// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installSpellingSampler } from "./preloadSampler.ts";

const FRENCH = "Les résultats montrent une amélioration significative.";
const GERMAN = "Die Ergebnisse zeigen eine deutliche Verbesserung.";

let send: ReturnType<typeof vi.fn<(sample: string) => void>>;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  send = vi.fn<(sample: string) => void>();
  uninstall = installSpellingSampler(send, window);
});

afterEach(() => {
  uninstall();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function focus(element: Element) {
  element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function typeInto(element: Element, caretIn: Node) {
  document.getSelection()!.collapse(caretIn, 0);
  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

describe("installSpellingSampler", () => {
  it("sends a rich editor's text when it gains focus, without its code", () => {
    document.body.innerHTML = `<div contenteditable="true"><p>${FRENCH}</p><pre spellcheck="false"><code>const value = computeSomething();</code></pre><p>Fin.</p></div>`;
    focus(document.querySelector("p")!);
    expect(send).toHaveBeenCalledExactlyOnceWith(`${FRENCH} Fin.`);
  });

  it("sends the paragraph being typed once typing pauses", () => {
    document.body.innerHTML = `<div contenteditable="true"><p>${FRENCH}</p><p>${GERMAN}</p></div>`;
    const editor = document.querySelector("div")!;
    const german = document.querySelectorAll("p")[1]!;
    typeInto(editor, german.firstChild!);
    typeInto(editor, german.firstChild!);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(send).toHaveBeenCalledExactlyOnceWith(GERMAN);
  });

  it("does not send the same text twice in a row", () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea>`;
    const field = document.querySelector("textarea")!;
    focus(field);
    focus(field);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignores fields without spellcheck and text too short to judge", () => {
    document.body.innerHTML = `<textarea spellcheck="false">${FRENCH}</textarea><div contenteditable="true">Titre</div><p>${FRENCH}</p>`;
    for (const element of document.body.children) focus(element);
    expect(send).not.toHaveBeenCalled();
  });

  it("stops listening once uninstalled", () => {
    uninstall();
    document.body.innerHTML = `<textarea>${FRENCH}</textarea>`;
    focus(document.querySelector("textarea")!);
    expect(send).not.toHaveBeenCalled();
  });
});
