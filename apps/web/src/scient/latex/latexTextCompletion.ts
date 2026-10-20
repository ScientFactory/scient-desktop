import { getKeyboardPreferences, subscribeKeyboardPreferences } from "../keyboard/preferences";
import {
  latexSourceChoices,
  type LatexCompletionContext,
  type LatexSourceChoice,
} from "./latexCommandCompletion";
import { latexCompletionMenu } from "./latexCompletionMenu";

export interface LatexCompletionAdapter {
  read(): { source: string; from: number; to: number } | null;
  apply(choice: LatexSourceChoice): boolean;
  allows?(choice: LatexSourceChoice): boolean;
  bounds(): DOMRect | { left: number; right: number; top: number; bottom: number };
}

/** Completion owns keys only while a backslash command or a known argument is being edited. */
export function installLatexTextCompletion(
  owner: HTMLElement,
  adapter: LatexCompletionAdapter,
  mode: "prose" | "source" | "math",
  context: () => LatexCompletionContext = () => ({}),
) {
  let choices: LatexSourceChoice[] = [];
  let query = "";
  let dismissed = "";
  let disposed = false;
  const menu = latexCompletionMenu(
    owner,
    () => adapter.bounds(),
    (index) => {
      const choice = choices[index];
      if (!choice || getKeyboardPreferences().preferences.completion === "off") return;
      const state = adapter.read();
      if (!state || state.from !== state.to) return;
      const current = latexSourceChoices(state.source, state.from, mode, context()).find(
        (candidate) =>
          candidate.label === choice.label &&
          candidate.from === choice.from &&
          candidate.to === choice.to &&
          adapter.allows?.(candidate) !== false,
      );
      if (!current) return;
      menu.hide();
      if (adapter.apply(current) && !current.label.startsWith("\\")) {
        const next = adapter.read();
        if (next) {
          query = `${next.from}:${next.source.slice(0, next.from)}`;
          dismissed = query;
        }
      }
      refresh();
    },
  );
  const refresh = () => {
    if (disposed) return;
    const state = adapter.read();
    choices =
      state && state.from === state.to && getKeyboardPreferences().preferences.completion !== "off"
        ? latexSourceChoices(state.source, state.from, mode, context()).filter(
            (choice) => adapter.allows?.(choice) !== false,
          )
        : [];
    const next = state ? `${state.from}:${state.source.slice(0, state.from)}` : "";
    const changed = query !== next;
    if (changed) {
      query = next;
      dismissed = "";
    }
    if (!choices.length || dismissed === query) return menu.hide();
    menu.show(choices, changed);
  };
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return false;
    refresh();
    if (menu.open && event.key === "Escape") {
      dismissed = query;
      menu.hide();
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    return menu.key(event, getKeyboardPreferences().preferences.completion === "space-tab");
  };
  const unsubscribe = subscribeKeyboardPreferences(refresh);
  return {
    refresh,
    key,
    hide: () => menu.hide(),
    dispose() {
      disposed = true;
      unsubscribe();
      menu.dispose();
    },
  };
}

/** Formula/source textareas share the anchored command list without owning their save queue. */
export function installLatexTextareaCompletion(
  field: HTMLTextAreaElement,
  apply: (choice: LatexSourceChoice) => void,
  context: () => LatexCompletionContext,
) {
  const completion = installLatexTextCompletion(
    field,
    {
      read: () =>
        field === field.ownerDocument.activeElement && !field.readOnly && !field.disabled
          ? { source: field.value, from: field.selectionStart, to: field.selectionEnd }
          : null,
      apply: (choice) => {
        apply(choice);
        return true;
      },
      bounds: () => field.getBoundingClientRect(),
    },
    "math",
    context,
  );
  const key = (event: KeyboardEvent) => completion.key(event);
  const refresh = () => completion.refresh();
  const blur = () => completion.hide();
  field.addEventListener("keydown", key, true);
  for (const name of ["input", "select", "keyup", "focus", "compositionend"])
    field.addEventListener(name, refresh);
  field.addEventListener("blur", blur);
  return () => {
    completion.dispose();
    field.removeEventListener("keydown", key, true);
    for (const name of ["input", "select", "keyup", "focus", "compositionend"])
      field.removeEventListener(name, refresh);
    field.removeEventListener("blur", blur);
  };
}
