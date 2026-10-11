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

/** The event that precedes the user editing a field; by default, typing one letter. */
function edit(element: Element, options: InputEventInit = {}) {
  element.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "a",
      ...options,
    }),
  );
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

  it("keeps a field's marks until the user next edits it, then rechecks it once", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea><textarea spellcheck="true">${GERMAN}</textarea>`;
    const [plain, explicit] = document.querySelectorAll("textarea");
    const plainValues = watchSpellcheck(plain!);
    const explicitValues = watchSpellcheck(explicit!);
    send.mockResolvedValue("added");
    focus(plain!);
    focus(explicit!);
    await vi.runAllTimersAsync();
    expect(plainValues).toEqual([]);
    edit(plain!);
    edit(plain!);
    edit(explicit!);
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
    edit(field);
    sampler.dictionaryReady();
    edit(field);
    await vi.runAllTimersAsync();
    expect(values).toEqual([]);
  });

  it("does not clear marks for keys or compositions that change nothing yet", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea>`;
    const field = document.querySelector("textarea")!;
    const values = watchSpellcheck(field);
    send.mockResolvedValue("added");
    focus(field);
    await vi.runAllTimersAsync();
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
    edit(field, { isComposing: true });
    await vi.runAllTimersAsync();
    expect(values).toEqual([]);
    edit(field);
    await vi.runAllTimersAsync();
    expect(values).toEqual([null, "false"]);
  });

  it("does not clear marks before edits that may change nothing", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea><textarea maxlength="${FRENCH.length}">${FRENCH}</textarea>`;
    const [field, full] = document.querySelectorAll("textarea");
    const values = watchSpellcheck(field!);
    const fullValues = watchSpellcheck(full!);
    send.mockResolvedValue("added");
    focus(field!);
    focus(full!);
    await vi.runAllTimersAsync();
    edit(field!, { inputType: "deleteContentBackward", data: null });
    edit(field!, { inputType: "historyUndo", data: null });
    field!.addEventListener("beforeinput", (event) => event.preventDefault(), { once: true });
    edit(field!);
    full!.setSelectionRange(FRENCH.length, FRENCH.length);
    edit(full!);
    await vi.runAllTimersAsync();
    expect(values).toEqual([]);
    expect(fullValues).toEqual([]);
    edit(field!);
    await vi.runAllTimersAsync();
    expect(values).toEqual([null, "false"]);
  });

  it("forgets a field once it is closed", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea><textarea>${GERMAN}</textarea>`;
    const [closed, open] = document.querySelectorAll("textarea");
    const closedValues = watchSpellcheck(closed!);
    send.mockResolvedValue("added");
    focus(closed!);
    await vi.runAllTimersAsync();
    edit(closed!);
    closed!.remove();
    focus(open!);
    await vi.runAllTimersAsync();
    document.body.append(closed!);
    sampler.dictionaryReady();
    edit(closed!);
    await vi.runAllTimersAsync();
    expect(closedValues).toEqual([null, "false"]);
  });

  it("rechecks every field a dictionary was added for once it finishes loading", async () => {
    document.body.innerHTML = `<textarea>${FRENCH}</textarea><textarea>${GERMAN}</textarea><textarea>English text that never added a dictionary.</textarea>`;
    const [french, german, english] = document.querySelectorAll("textarea");
    const frenchValues = watchSpellcheck(french!);
    const germanValues = watchSpellcheck(german!);
    const englishValues = watchSpellcheck(english!);
    send.mockResolvedValueOnce("added").mockResolvedValueOnce("added");
    focus(french!);
    await vi.runAllTimersAsync();
    edit(french!);
    focus(german!);
    await vi.runAllTimersAsync();
    focus(english!);
    await vi.runAllTimersAsync();
    sampler.dictionaryReady();
    for (const field of [french!, german!, english!]) edit(field);
    await vi.runAllTimersAsync();
    expect(frenchValues).toEqual([null, "false", null, "false"]);
    expect(germanValues).toEqual([null, "false"]);
    expect(englishValues).toEqual([]);
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
