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

/**
 * Clears a field's spelling marks so that Chromium checks it again, with the
 * dictionaries now enabled, on the user's next keystroke. Chromium does not
 * recheck text by itself when dictionaries change, and ignores a script asking
 * it to; switching the field's spellcheck off and back on is what resets it.
 */
export function recheckSpelling(field: Element | null): void {
  if (field === null || !field.isConnected) return;
  const previous = field.getAttribute("spellcheck");
  field.setAttribute("spellcheck", "false");
  if (previous === null) field.removeAttribute("spellcheck");
  else field.setAttribute("spellcheck", previous);
}

/** Rechecks the field being edited, if any. */
export function recheckFocusedField(doc: Document = document): void {
  recheckSpelling(spellcheckedField(doc.activeElement));
}

/**
 * Sends the main process a sample of the text being edited, so that it can
 * enable the matching spelling dictionary, and rechecks the field when it
 * does. `send` resolves true when a dictionary was added. Windows and Linux
 * only: macOS detects the language itself.
 */
export function installSpellingSampler(
  send: (sample: string) => Promise<boolean>,
  target: EventTarget = window,
): () => void {
  let lastSample = "";
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  const dispatch = (field: EditableField, sample: string) => {
    const trimmed = sample.trim();
    if (trimmed.length < MIN_SAMPLE_LENGTH || trimmed === lastSample) return;
    lastSample = trimmed;
    void send(trimmed).then((added) => {
      if (added) recheckSpelling(field);
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
  target.addEventListener("focusin", onFocus, true);
  target.addEventListener("input", onInput, true);
  return () => {
    clearTimeout(typingTimer);
    target.removeEventListener("focusin", onFocus, true);
    target.removeEventListener("input", onInput, true);
  };
}
