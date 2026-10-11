/** Enough text to recognise a language; detection reads no further. */
const SAMPLE_LENGTH = 2_000;
/** Chromium checks a field when it gains focus and again as the user types. */
const TYPING_PAUSE_MS = 1_500;
const MIN_SAMPLE_LENGTH = 20;
const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption, dd, dt";

type EditableField = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

/** HTML's rule: the nearest element that sets spellcheck decides, and editable text defaults to on. */
const isSpellchecked = (element: Element): boolean =>
  element.closest("[spellcheck]")?.getAttribute("spellcheck") !== "false";

/** Parts of an editor Chromium does not check: code, images, citations and the like. */
const isUnchecked = (element: Element): boolean =>
  element.getAttribute("spellcheck") === "false" ||
  element.getAttribute("contenteditable") === "false";

function isCheckedWithin(element: Element, field: Element): boolean {
  for (
    let node: Element | null = element;
    node !== null && node !== field;
    node = node.parentElement
  ) {
    if (isUnchecked(node)) return false;
  }
  return true;
}

/** The spellchecked field an event happened in, or null for anything else. */
function spellcheckedField(target: EventTarget | null): EditableField | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLTextAreaElement) return isSpellchecked(target) ? target : null;
  if (target instanceof HTMLInputElement) {
    return target.type === "text" && isSpellchecked(target) ? target : null;
  }
  if (!target.isContentEditable) return null;
  let root = target;
  while (root.parentElement?.isContentEditable) root = root.parentElement;
  return isSpellchecked(root) ? root : null;
}

/** Text Chromium would check, skipping the parts it leaves out. */
function checkedText(root: Element, limit: number): string {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.nodeType === Node.TEXT_NODE
          ? NodeFilter.FILTER_ACCEPT
          : node !== root && node instanceof Element && isUnchecked(node)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP,
    },
  );
  let text = "";
  for (
    let node = walker.nextNode();
    node !== null && text.length < limit;
    node = walker.nextNode()
  ) {
    text += `${node.textContent ?? ""} `;
  }
  return text.slice(0, limit);
}

/** A field's opening text: what the user sees when it gains focus. */
function openingSample(field: EditableField): string {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    return field.value.slice(0, SAMPLE_LENGTH);
  }
  return checkedText(field, SAMPLE_LENGTH);
}

/** The paragraph being typed, which may be in another language than the opening. */
function typingSample(field: EditableField): string {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    const caret = field.selectionStart ?? field.value.length;
    return field.value.slice(Math.max(0, caret - SAMPLE_LENGTH / 2), caret + SAMPLE_LENGTH / 2);
  }
  const anchor = field.ownerDocument.getSelection()?.anchorNode ?? null;
  const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  const block = element?.closest(BLOCK_SELECTOR);
  if (!block || !field.contains(block)) return openingSample(field);
  return isCheckedWithin(block, field) ? checkedText(block, SAMPLE_LENGTH) : "";
}

/** A text field with a maximum length cuts or refuses typed text that does not fit. */
function fits(field: EditableField, text: string): boolean {
  if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return true;
  if (field.maxLength < 0) return true;
  const selected = (field.selectionEnd ?? 0) - (field.selectionStart ?? 0);
  return field.value.length - selected + text.length <= field.maxLength;
}

/** What the main process did with a sample. */
export type SampleOutcome = "added" | "unchanged" | "failed";

/**
 * Clears a field's spelling marks. Chromium does not recheck text when
 * dictionaries change, and ignores a script asking it to, but switching a
 * field's spellcheck off and back on makes the next edit by the user recheck
 * the whole field.
 */
function clearSpellingMarks(field: Element): void {
  const previous = field.getAttribute("spellcheck");
  field.setAttribute("spellcheck", "false");
  if (previous === null) field.removeAttribute("spellcheck");
  else field.setAttribute("spellcheck", previous);
}

export interface SpellingSampler {
  /** A dictionary finished loading, for example after its first download. */
  readonly dictionaryReady: () => void;
  readonly uninstall: () => void;
}

/**
 * Sends the main process a sample of the text being edited, so that it can
 * enable the matching spelling dictionary. Windows and Linux only: macOS
 * detects the language itself.
 *
 * A field whose language was just added is rechecked when the user next
 * types into it: its marks are cleared just ahead of text that is certain to
 * be inserted, which is what makes Chromium check the field again. Clearing
 * them before anything that might change nothing (a modifier key, Backspace
 * at the start, a cancelled edit) would hide real typos until the user typed
 * again, so the field simply stays marked until then.
 */
export function installSpellingSampler(
  send: (sample: string) => Promise<SampleOutcome>,
  target: EventTarget = window,
): SpellingSampler {
  let lastSample = "";
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  /** Open fields this sampler has looked at. */
  const sampled = new Set<Element>();
  /** Fields to recheck when the user next types into them. */
  const stale = new WeakSet<Element>();
  // Any of them may hold text in a language whose dictionary just changed, and
  // marking one costs nothing until the user types into it.
  const markSampledFieldsStale = () => {
    for (const field of sampled) {
      if (field.isConnected) stale.add(field);
      else sampled.delete(field);
    }
  };
  const dispatch = (field: EditableField, sample: string) => {
    sampled.add(field);
    const trimmed = sample.trim();
    if (trimmed.length < MIN_SAMPLE_LENGTH || trimmed === lastSample) return;
    lastSample = trimmed;
    void send(trimmed).then((outcome) => {
      if (outcome === "added") markSampledFieldsStale();
      else if (outcome === "failed" && lastSample === trimmed) lastSample = "";
    });
  };
  const onFocus = (event: Event) => {
    const field = spellcheckedField(event.target);
    if (field !== null) dispatch(field, openingSample(field));
  };
  const onInput = (event: Event) => {
    const field = spellcheckedField(event.target);
    if (field === null) return;
    clearTimeout(typingTimer);
    // @effect-diagnostics-next-line globalTimers:off - The preload runs plain DOM code, outside any Effect runtime.
    typingTimer = setTimeout(() => dispatch(field, typingSample(field)), TYPING_PAUSE_MS);
  };
  // Listens after the editor's own handlers, so an edit it cancels is seen as cancelled.
  const onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    // Typed text always changes the field, unless cancelled, still being
    // composed by an input method, or too long for the field.
    if (input.inputType !== "insertText" || !input.data || input.isComposing) return;
    if (input.defaultPrevented) return;
    const field = spellcheckedField(event.target);
    if (field === null || !stale.has(field) || !fits(field, input.data)) return;
    stale.delete(field);
    clearSpellingMarks(field);
  };
  target.addEventListener("focusin", onFocus, true);
  target.addEventListener("input", onInput, true);
  target.addEventListener("beforeinput", onBeforeInput);
  return {
    dictionaryReady: markSampledFieldsStale,
    uninstall: () => {
      clearTimeout(typingTimer);
      target.removeEventListener("focusin", onFocus, true);
      target.removeEventListener("input", onInput, true);
      target.removeEventListener("beforeinput", onBeforeInput);
    },
  };
}
