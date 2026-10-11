// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  installSpellingSampler,
  type SampleOutcome,
  type SpellingSampler,
} from "./preloadSampler.ts";

const FRENCH = "Les résultats montrent une amélioration significative.";
const GERMAN = "Die Ergebnisse zeigen eine deutliche Verbesserung.";

let send: ReturnType<typeof vi.fn<(sample: string) => Promise<SampleOutcome>>>;
let sampler: SpellingSampler;

beforeEach(() => {
  vi.useFakeTimers();
  send = vi.fn<(sample: string) => Promise<SampleOutcome>>().mockResolvedValue("unchanged");
  sampler = installSpellingSampler(send, window);
});

afterEach(() => {
  sampler.uninstall();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function focus(element: Element) {
  element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function pressKey(element: Element) {
  element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
}

function typeInto(element: Element, caretIn: Node) {
  document.getSelection()!.collapse(caretIn, 0);
  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

/**
 * The spellcheck value before each change to a field. Passing through "false"
 * is what makes Chromium check the field again.
 */
function watchSpellcheck(element: Element): (string | null)[] {
  const previousValues: (string | null)[] = [];
  new MutationObserver((records) => {
    for (const record of records) previousValues.push(record.oldValue);
  }).observe(element, { attributeFilter: ["spellcheck"], attributeOldValue: true });
  return previousValues;
}

describe("installSpellingSampler", () => {
  it("sends a rich editor's text when it gains focus, without its code", () => {
    document.body.innerHTML = `<div contenteditable="true"><p>${FRENCH}</p><pre spellcheck="false"><code>const value = computeSomething();</code></pre><p>Fin.</p></div>`;
    focus(document.querySelector("p")!);
    expect(send).toHaveBeenCalledExactlyOnceWith(`${FRENCH} Fin.`);
  });

  it("leaves out parts that are not editable, such as code blocks", () => {
    document.body.innerHTML = `<div contenteditable="true"><div contenteditable="false"><pre>${GERMAN}</pre></div><p>${FRENCH}</p></div>`;
    focus(document.querySelector("p")!);
    expect(send).toHaveBeenCalledExactlyOnceWith(FRENCH);
  });

  it("does not send a paragraph typed inside a part without spellcheck", () => {
    document.body.innerHTML = `<div contenteditable="true"><blockquote spellcheck="false"><p>${GERMAN}</p></blockquote></div>`;
    typeInto(document.querySelector("div")!, document.querySelector("p")!.firstChild!);
    vi.advanceTimersByTime(1_500);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a field's marks until the user's next keystroke in it, then rechecks it once", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea><textarea spellcheck="true">${GERMAN}</textarea>`;
    const [plain, explicit] = document.querySelectorAll("textarea");
    const plainValues = watchSpellcheck(plain!);
    const explicitValues = watchSpellcheck(explicit!);
    send.mockResolvedValue("added");
    focus(plain!);
    focus(explicit!);
    await vi.runAllTimersAsync();
    expect(plainValues).toEqual([]);
    pressKey(plain!);
    pressKey(plain!);
    pressKey(explicit!);
    await vi.runAllTimersAsync();
    expect(plainValues).toEqual([null, "false"]);
    expect(plain!.hasAttribute("spellcheck")).toBe(false);
    expect(explicitValues).toEqual(["true", "false"]);
    expect(explicit!.getAttribute("spellcheck")).toBe("true");
  });

  it("leaves a field alone when no dictionary was added for it", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea>`;
    const field = document.querySelector("textarea")!;
    const values = watchSpellcheck(field);
    focus(field);
    await vi.runAllTimersAsync();
    pressKey(field);
    sampler.dictionaryReady();
    pressKey(field);
    await vi.runAllTimersAsync();
    expect(values).toEqual([]);
  });

  it("rechecks again after a dictionary finishes loading, only where it was added", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea><textarea>${GERMAN}</textarea>`;
    const [french, other] = document.querySelectorAll("textarea");
    const frenchValues = watchSpellcheck(french!);
    const otherValues = watchSpellcheck(other!);
    send.mockResolvedValueOnce("added");
    focus(french!);
    await vi.runAllTimersAsync();
    pressKey(french!);
    focus(other!);
    sampler.dictionaryReady();
    pressKey(other!);
    pressKey(french!);
    await vi.runAllTimersAsync();
    expect(frenchValues).toEqual([null, "false", null, "false"]);
    expect(otherValues).toEqual([]);
  });

  it("sends the same text again after the main process failed to use it", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea>`;
    const field = document.querySelector("textarea")!;
    send.mockResolvedValueOnce("failed");
    focus(field);
    await vi.runAllTimersAsync();
    focus(field);
    await vi.runAllTimersAsync();
    focus(field);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(2);
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
    sampler.uninstall();
    document.body.innerHTML = `<textarea>${FRENCH}</textarea>`;
    focus(document.querySelector("textarea")!);
    expect(send).not.toHaveBeenCalled();
  });
});
