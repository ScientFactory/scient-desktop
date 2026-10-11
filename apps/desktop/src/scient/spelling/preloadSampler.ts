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

/** Text Chromium would check, skipping code and other parts marked spellcheck="false". */
function checkedText(root: Element, limit: number): string {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.nodeType === Node.TEXT_NODE
          ? NodeFilter.FILTER_ACCEPT
          : node instanceof Element && node.getAttribute("spellcheck") === "false"
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
  return block && field.contains(block) ? checkedText(block, SAMPLE_LENGTH) : openingSample(field);
}

/**
 * Sends the main process a sample of the text being edited, so that it can
 * enable the matching spelling dictionary. Windows and Linux only: macOS
 * detects the language itself.
 */
export function installSpellingSampler(
  send: (sample: string) => void,
  target: EventTarget = window,
): () => void {
  let lastSample = "";
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  const dispatch = (sample: string) => {
    const trimmed = sample.trim();
    if (trimmed.length < MIN_SAMPLE_LENGTH || trimmed === lastSample) return;
    lastSample = trimmed;
    send(trimmed);
  };
  const onFocus = (event: Event) => {
    const field = spellcheckedField(event.target);
    if (field !== null) dispatch(openingSample(field));
  };
  const onInput = (event: Event) => {
    const field = spellcheckedField(event.target);
    if (field === null) return;
    clearTimeout(typingTimer);
    // @effect-diagnostics-next-line globalTimers:off - The preload runs plain DOM code, outside any Effect runtime.
    typingTimer = setTimeout(() => dispatch(typingSample(field)), TYPING_PAUSE_MS);
  };
  target.addEventListener("focusin", onFocus, true);
  target.addEventListener("input", onInput, true);
  return () => {
    clearTimeout(typingTimer);
    target.removeEventListener("focusin", onFocus, true);
    target.removeEventListener("input", onInput, true);
  };
}
