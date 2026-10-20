import type { MathfieldElement } from "mathlive";
import { getKeyboardPreferences } from "../keyboard/preferences";
import {
  mathArgumentCompletion,
  mathEnvironmentCompletions,
  mathCommandCompletions,
  type MathCommandCompletion,
} from "./mathCommandCompletion";
import "./mathCommandCompletion.css";
import { enterMathArgument, mathTextFormattingInput } from "./mathTextFormatting";
import { latexArgumentChoices, type LatexCompletionContext } from "./latexCommandCompletion";

interface CommandAtom {
  readonly type?: string;
  readonly value?: string;
  readonly isSuggestion?: boolean;
  readonly body?: readonly CommandAtom[];
}
interface CommandModel {
  readonly atoms: readonly CommandAtom[];
  offsetOf(atom: CommandAtom): number;
}

/** MathLive exposes command atoms through its model, but has no argument-completion hook. */
function commandDraft(math: MathfieldElement) {
  if (math.mode !== "latex" || !math.selectionIsCollapsed) return null;
  const model = (math as unknown as { _mathfield?: { model?: CommandModel } })._mathfield?.model;
  const group = model?.atoms.find((atom) => atom.type === "latexgroup");
  if (!model || !group?.body) return null;
  const atoms = group.body.filter((atom) => atom.type === "latex");
  const typed = atoms.filter((atom) => !atom.isSuggestion);
  return {
    typed: typed.map((atom) => atom.value ?? "").join(""),
    suggested: atoms.map((atom) => atom.value ?? "").join(""),
    before: typed
      .filter((atom) => model.offsetOf(atom) <= math.position)
      .map((atom) => atom.value ?? "")
      .join(""),
    after: typed
      .filter((atom) => model.offsetOf(atom) > math.position)
      .map((atom) => atom.value ?? "")
      .join(""),
    end: atoms.length ? model.offsetOf(atoms.at(-1)!) : math.position,
  };
}

/** Extend native command completion with brace arguments and local environment choices. */
export function installMathCommandCompletion(
  math: MathfieldElement,
  hasDocumentMacro: (command: string) => boolean,
  context: () => LatexCompletionContext = () => ({}),
) {
  const document = math.ownerDocument;
  const menu = document.createElement("div");
  menu.id = `${math.id}-completions`;
  menu.className = "scient-latex-command-completion";
  menu.dataset.latexSelectOwner = math.id;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "LaTeX completions");
  menu.hidden = true;
  let choices: MathCommandCompletion[] = [];
  let active = 0;
  let query = "";
  let dismissed = "";
  let disposed = false;
  let queued = false;
  let positioning = false;
  const preferences = () => getKeyboardPreferences().preferences;
  const watchPosition = (enabled: boolean) => {
    if (enabled === positioning) return;
    positioning = enabled;
    if (enabled) {
      document.addEventListener("scroll", position, true);
      document.defaultView?.addEventListener("resize", position);
    } else {
      document.removeEventListener("scroll", position, true);
      document.defaultView?.removeEventListener("resize", position);
    }
  };
  const hide = (keepNativeHidden = false) => {
    if (!keepNativeHidden) math.removeAttribute("data-environment-completion");
    if (menu.hidden) return;
    menu.hidden = true;
    watchPosition(false);
    math.removeAttribute("aria-activedescendant");
    math.removeAttribute("aria-controls");
  };
  const accept = (completion: MathCommandCompletion, focus = true) => {
    if (math.readOnly || preferences().completion === "off" || !commandDraft(math)) return;
    hide();
    // Reject the raw command before inserting; surrounding formula atoms stay intact.
    math.executeCommand(["complete", "reject"]);
    if (completion.argument) {
      const latex = completion.latex.replace(/#[0-9?]/gu, "");
      math.executeCommand(["switchMode", "latex", "", latex]);
      const firstArgument = Math.max(0, latex.indexOf("{}")) + 1;
      math.position -= latex.length - firstArgument;
    } else if (/^\\color\{[^{}]+\}$/u.test(completion.latex) && !hasDocumentMacro("\\color")) {
      math.executeCommand(["switchMode", "math"]);
      math.applyStyle({ color: completion.latex.slice(7, -1) });
    } else {
      math.insert(
        hasDocumentMacro("\\htmlData")
          ? completion.latex
          : mathTextFormattingInput(completion.latex, context().macros),
        {
          format: "latex",
          mode: "math",
          selectionMode: "placeholder",
          focus,
        },
      );
      if (completion.text) math.executeCommand(["switchMode", "text"]);
      enterMathArgument(math);
    }
    if (focus) math.focus();
    refresh();
  };
  const position = () => {
    if (menu.hidden) return;
    const caret = math.shadowRoot?.querySelector(".ML__latex-caret,.ML__caret,.ML__text-caret");
    const bounds = (caret ?? math).getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const viewport = document.documentElement;
    menu.style.left = `${Math.max(8, Math.min(bounds.left, viewport.clientWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, bounds.bottom + height + 8 > viewport.clientHeight ? bounds.top - height - 4 : bounds.bottom + 4)}px`;
  };
  const refresh = () => {
    if (disposed) return;
    const draft = math.hasFocus() && !math.readOnly ? commandDraft(math) : null;
    const nextQuery = draft?.before ?? "";
    choices = [];
    if (draft && preferences().completion !== "off") {
      const argumentChoices = latexArgumentChoices(draft.typed, draft.before.length, context());
      choices = argumentChoices.map((choice) => {
        const before = draft.typed.slice(0, choice.from) + choice.replacement;
        let after = draft.typed.slice(choice.to);
        if (!after.startsWith("}")) after = "}" + after;
        const latex = (before + after).replace(/\{\}/gu, "{#?}");
        const pendingColor = /^\\fcolorbox\{[^{}]+\}\{\}/u.test(latex.replace(/#\?/gu, ""));
        return { label: choice.label, preview: before + after, latex, argument: pendingColor };
      });
      if (!choices.length && /^\}?$/u.test(draft.after))
        choices =
          hasDocumentMacro("\\begin") && nextQuery.startsWith("\\begin")
            ? []
            : mathCommandCompletions(nextQuery, context());
    }
    if (nextQuery !== query) {
      query = nextQuery;
      active = 0;
      dismissed = "";
    }
    if (!choices.length || dismissed === query) return hide(Boolean(choices.length));
    active = Math.min(active, choices.length - 1);
    menu.replaceChildren(
      ...choices.map((choice, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `${menu.id}-${index}`;
        option.textContent = choice.preview ?? choice.latex.replace(/#[0-9?]/gu, "");
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === active));
        option.addEventListener("pointerdown", (event) => event.preventDefault());
        option.addEventListener("click", () => accept(choice));
        return option;
      }),
    );
    if (!menu.isConnected) document.body.append(menu);
    menu.hidden = false;
    watchPosition(true);
    math.setAttribute("data-environment-completion", "");
    math.setAttribute("aria-controls", menu.id);
    math.setAttribute("aria-activedescendant", `${menu.id}-${active}`);
    position();
    const selected = menu.children[active];
    if (selected instanceof HTMLElement) {
      if (selected.offsetTop < menu.scrollTop) menu.scrollTop = selected.offsetTop;
      else if (selected.offsetTop + selected.offsetHeight > menu.scrollTop + menu.clientHeight)
        menu.scrollTop = selected.offsetTop + selected.offsetHeight - menu.clientHeight;
    }
  };
  const schedule = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      refresh();
    });
  };
  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (
      event.isComposing ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      math.readOnly ||
      preferences().completion === "off"
    )
      return false;
    const draft = commandDraft(math);
    if (!draft) return false;
    const consume = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    };
    if (event.key === "Backspace" && draft.before.endsWith("{") && draft.after.startsWith("}")) {
      math.selection = { ranges: [[math.position - 1, math.position + 1]] };
      math.executeCommand("deleteBackward");
      refresh();
      return consume();
    }
    // Pair braces in the explicit LaTeX draft; skip its existing closing brace.
    if (event.key === "{" && draft.before.startsWith("\\")) {
      // Remove only ghost suggestions. Text after a moved caret is real input.
      if (!draft.after) math.selection = { ranges: [[math.position, draft.end]] };
      math.insert("{}", { mode: "latex", selectionMode: "after" });
      math.position -= 1;
      refresh();
      return consume();
    }
    if (event.key === "}" && draft.after.startsWith("}")) {
      const exact =
        !hasDocumentMacro("\\begin") &&
        mathEnvironmentCompletions(draft.before).find(
          (choice) => choice.label === `${draft.before}}`,
        );
      if (exact) accept(exact);
      else math.position += 1;
      refresh();
      return consume();
    }
    refresh();
    if (!menu.hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      refresh();
      return consume();
    }
    if (!menu.hidden && event.key === "Escape") {
      dismissed = query;
      hide(true);
      return consume();
    }
    const accepts =
      !event.shiftKey &&
      (event.key === "Tab" ||
        event.key === "Enter" ||
        (event.key === " " && preferences().completion === "space-tab"));
    if (!accepts) return false;
    if (!menu.hidden && choices[active]) {
      accept(choices[active]!);
      return consume();
    }
    const argument = mathArgumentCompletion(draft.suggested) ?? mathArgumentCompletion(draft.typed);
    if (argument && !hasDocumentMacro(argument.label)) {
      accept(argument);
      return consume();
    }
    return false;
  };
  const completeTyped = () => {
    const draft = commandDraft(math);
    const completion = draft && mathArgumentCompletion(draft.typed);
    if (
      math.readOnly ||
      preferences().completion === "off" ||
      !completion ||
      hasDocumentMacro(completion.label)
    )
      return false;
    accept(completion, false);
    return true;
  };
  // MathLive's native suggestion clicks bypass the keyboard completion adapter.
  const suggested = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || !math.hasFocus() || !commandDraft(math)) return;
    const option = event.target.closest<HTMLElement>("#mathlive-suggestion-popover [data-command]");
    const completion = option && mathArgumentCompletion(option.dataset.command ?? "");
    if (
      math.readOnly ||
      preferences().completion === "off" ||
      !completion ||
      hasDocumentMacro(completion.label)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    accept(completion);
  };
  document.addEventListener("click", suggested, true);
  for (const name of ["input", "selection-change", "mode-change", "focus"])
    math.addEventListener(name, schedule);
  const blur = () => hide();
  math.addEventListener("blur", blur);
  return {
    handleKeyDown,
    completeTyped,
    refresh: schedule,
    dispose() {
      disposed = true;
      hide();
      menu.remove();
      for (const name of ["input", "selection-change", "mode-change", "focus"])
        math.removeEventListener(name, schedule);
      math.removeEventListener("blur", blur);
      document.removeEventListener("click", suggested, true);
    },
  };
}
