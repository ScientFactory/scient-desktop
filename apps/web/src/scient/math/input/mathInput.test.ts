// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { commandEdit, mathCommand, MATH_COMMANDS } from "./catalog";
import { mathContext } from "./context";
import { insertMatrix, matrixAt, matrixEdit } from "./matrix";
import { MathInputController, type MathInputSnapshot } from "./controller";
import { defaultMathBindings } from "./keymap";
import { normalizeKeys as normalizeMathKeys } from "../../keyboard/keys";
import { importKeyboardPreferences, reloadKeyboardPreferences } from "../../keyboard/preferences";
import { mathInputOwnsEvent } from "./ownership";

function fixture(source = "", format: MathInputSnapshot["format"] = "tex", platform = "Linux") {
  let state: MathInputSnapshot = {
    source,
    selection: { from: source.length, to: source.length },
    format,
    editable: true,
  };
  const edits: string[] = [];
  const controller = new MathInputController(
    {
      read: () => state,
      focus: () => {},
      apply(expected, edit) {
        if (expected.source !== state.source) return false;
        const next = state.source.slice(0, edit.from) + edit.insert + state.source.slice(edit.to);
        edits.push(next);
        state = { ...state, source: next, selection: edit.selection };
        return true;
      },
    },
    platform,
  );
  return {
    controller,
    state: () => state,
    set: (patch: Partial<MathInputSnapshot>) => {
      state = { ...state, ...patch };
    },
    edits,
  };
}
function key(key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  // happy-dom aliases Alt to AltGraph; browsers distinguish those physical keys.
  const original = event.getModifierState.bind(event);
  event.getModifierState = (modifier) => (modifier === "AltGraph" ? false : original(modifier));
  return event;
}
afterEach(() => {
  localStorage.clear();
  reloadKeyboardPreferences();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("shared math commands", () => {
  it("uses unique stable commands and no literal placeholder characters", () => {
    expect(new Set(MATH_COMMANDS.map((item) => item.id)).size).toBe(MATH_COMMANDS.length);
    for (const command of MATH_COMMANDS) {
      const edit = commandEdit(command, "x+1", { from: 0, to: 3 });
      expect(edit.insert).not.toContain("@");
      expect(edit.insert).not.toContain("|");
      expect(edit.selection.from).toBeLessThanOrEqual(edit.insert.length);
    }
  });
  it("wraps a selection and places the caret in the denominator", () => {
    const edit = commandEdit(mathCommand("math.fraction")!, "x+1", { from: 0, to: 3 });
    expect(edit.insert).toBe("\\frac{x+1}{}");
    expect(edit.insert[edit.selection.from - 1]).toBe("{");
    expect(edit.insert[edit.selection.from]).toBe("}");
  });
  it.each(["markdown", "latex"] as const)("creates math from prose in %s", (format) => {
    const f = fixture("hello ", format);
    expect(f.controller.execute("math.symbol.alpha")).toBe(true);
    expect(f.state().source).toBe("hello \\(\\alpha \\)");
  });
  it("completes a fraction and preserves surrounding math delimiters", () => {
    const f = fixture("$\\frac$", "markdown");
    f.set({ selection: { from: 6, to: 6 } });
    expect(f.controller.handle(key("Tab"))).toBe(true);
    expect(f.state().source).toBe("$\\frac{}{}$");
  });
  it("applies Greek sequences only to the focused enabled editor", () => {
    const f = fixture();
    const input = document.createElement("textarea");
    document.body.append(input);
    const release = f.controller.attach(input);
    input.addEventListener("keydown", (event) => expect(mathInputOwnsEvent(event)).toBe(false));
    input.dispatchEvent(key("m", { altKey: true }));
    input.dispatchEvent(key("g"));
    input.dispatchEvent(key("a"));
    expect(f.state().source).toBe("\\alpha ");
    release();
    input.dispatchEvent(key("m", { altKey: true }));
    input.dispatchEvent(key("g"));
    input.dispatchEvent(key("b"));
    expect(f.state().source).toBe("\\alpha ");
  });
  it("lets the active math scope own application-conflicting display insertion", () => {
    const f = fixture("", "markdown");
    const host = document.createElement("div");
    const input = document.createElement("textarea");
    host.append(input);
    document.body.append(host);
    const release = f.controller.attach(host);
    let claimed = false;
    const capture = (event: KeyboardEvent) => {
      claimed = mathInputOwnsEvent(event);
    };
    window.addEventListener("keydown", capture, true);
    input.dispatchEvent(key("M", { ctrlKey: true, shiftKey: true }));
    expect(claimed).toBe(true);
    expect(f.state().source).toBe("\n$$\n{}\n$$\n");
    window.removeEventListener("keydown", capture, true);
    release();
  });
  it("does not hijack IME, AltGraph, read-only fields, or expired prefixes", () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.controller.handle(key("m", { altKey: true, isComposing: true }))).toBe(false);
    f.controller.handle(key("m", { altKey: true }));
    vi.advanceTimersByTime(2600);
    expect(f.controller.handle(key("f"))).toBe(false);
    f.set({ editable: false });
    expect(f.controller.execute("math.fraction")).toBe(false);
    expect(f.edits).toEqual([]);
  });
  it("restricts operator transformations to equations", () => {
    const prose = fixture("a-", "markdown");
    expect(prose.controller.handle(key(">"))).toBe(false);
    const math = fixture("a-");
    expect(math.controller.handle(key(">"))).toBe(true);
    expect(math.state().source).toBe("a\\to ");
  });
  it("keeps text arguments and comments literal", () => {
    for (const source of ["\\text{a-", "x % a-", "\\text{nested {a}-"]) {
      expect(fixture(source).controller.handle(key(">"))).toBe(false);
      expect(fixture(source).controller.execute("math.symbol.alpha")).toBe(false);
    }
  });
  it("consumes a recognized but unavailable matrix chord without typing its last key", () => {
    const f = fixture("x");
    f.controller.handle(key("m", { altKey: true }));
    f.controller.handle(key("c"));
    const event = key("d");
    expect(f.controller.handle(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(f.state().source).toBe("x");
    expect(f.controller.getSnapshot().notice).toContain("not changed");
  });
  it("completes a searched command without retaining its typed prefix", () => {
    const f = fixture("x+\\al");
    expect(f.controller.execute("math.palette")).toBe(true);
    expect(f.controller.getSnapshot().query).toBe("al");
    expect(f.controller.execute("math.symbol.alpha")).toBe(true);
    expect(f.state().source).toBe("x+\\alpha ");
  });
  it("refuses stale palette selections and undeclared package dependencies", () => {
    const f = fixture("x");
    f.controller.open();
    f.set({ source: "y" });
    expect(f.controller.execute("math.symbol.alpha")).toBe(false);
    const latex = fixture("\\begin{document}Hello\\end{document}", "latex");
    latex.set({ selection: { from: 21, to: 21 } });
    expect(latex.controller.matrix("pmatrix", 2, 2)).toBe(false);
    expect(latex.controller.getSnapshot().notice).toContain("amsmath");
    expect(latex.edits).toHaveLength(0);
  });
  it("has no default key collisions on either platform", () => {
    for (const mac of [false, true]) {
      const keys = defaultMathBindings(mac).map((item) => normalizeMathKeys(item.keys, mac));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  it("accepts shifted punctuation and non-Latin physical keys inside a prefix", () => {
    const f = fixture();
    f.controller.handle(key("m", { altKey: true }));
    expect(f.controller.handle(key("+", { shiftKey: true }))).toBe(true);
    expect(f.state().source).toBe("\\pm ");
    f.controller.handle(key("m", { altKey: true }));
    f.controller.handle(key("ע", { code: "KeyG" }));
    expect(f.controller.handle(key("ש", { code: "KeyA" }))).toBe(true);
    expect(f.state().source).toBe("\\pm \\alpha ");
  });
  it("validates custom commands and prevents bare typing shortcuts", () => {
    expect(
      importKeyboardPreferences('[{"keys":"alt+a","command":"math.symbol.alpha"}]').overrides[
        "math.symbol.alpha"
      ],
    ).toContain("alt+a");
    expect(() =>
      importKeyboardPreferences('[{"keys":"a","command":"math.symbol.alpha"}]'),
    ).toThrow();
    expect(() => importKeyboardPreferences('[{"keys":"alt+a","command":"shell.exec"}]')).toThrow();
    expect(() =>
      importKeyboardPreferences('[{"keys":"alt+nonsense+a","command":"math.symbol.alpha"}]'),
    ).toThrow();
    expect(() =>
      importKeyboardPreferences(
        '[{"keys":"alt+a","command":"math.symbol.alpha"},{"keys":"alt+a b","command":"math.symbol.beta"}]',
      ),
    ).toThrow();
  });
});

describe("source context", () => {
  it.each([
    "`$x$`",
    "```tex\n$x$\n```",
    "    $x$",
    "<code>$x$</code>",
    "<!-- $x$ -->",
    "[link]($x$)",
  ])("leaves Markdown code opaque: %s", (source) => {
    const from = source.indexOf("x");
    expect(mathContext(source, { from, to: from }, "markdown")).toBeNull();
  });
  it.each(["% $x$", "\\verb|$x$|", "\\begin{verbatim}$x$\\end{verbatim}"])(
    "leaves TeX literal regions opaque: %s",
    (source) => {
      const from = source.indexOf("x");
      expect(mathContext(source, { from, to: from }, "latex")).toBeNull();
    },
  );
  it("recognizes backslash math and equation environments", () => {
    for (const source of ["\\(x\\)", "\\[x\\]", "\\begin{equation}x\\end{equation}"]) {
      const from = source.indexOf("x");
      expect(mathContext(source, { from, to: from }, "latex")).toMatchObject({ from });
    }
  });
  it("refuses unmatched delimiters and cross-equation selections", () => {
    expect(mathContext("$x", { from: 2, to: 2 }, "markdown")).toBeNull();
    expect(mathContext("$x$ text $y$", { from: 1, to: 10 }, "markdown")).toBeNull();
  });
});

describe("matrix transactions", () => {
  it("navigates and adds rows from text cells without expanding their ordinary text", () => {
    const source = "\\begin{cases}x & \\text{if x}\\\\y & \\text{otherwise}\\end{cases}";
    const f = fixture(source);
    const caret = source.indexOf("if x") + 2;
    f.set({ selection: { from: caret, to: caret } });
    expect(f.controller.execute("math.matrix.unknown")).toBe(false);
    expect(f.controller.handle(key("Tab"))).toBe(true);
    expect(f.state().selection.from).toBeGreaterThan(caret);
    f.set({ selection: { from: caret, to: caret } });
    expect(f.controller.execute("math.matrix.addRow")).toBe(true);
    expect(f.state().source).toContain("\\text{if x}");
  });
  it("inserts, navigates, and adds a row with one edit per operation", () => {
    const edit = insertMatrix({ from: 0, to: 0 }, "pmatrix", 2, 2)!;
    expect(edit.insert).toContain("{} & {} \\\\");
    const parsed = matrixAt(edit.insert, edit.selection.from)!;
    expect(parsed.rows.map((row) => row.length)).toEqual([2, 2]);
    const next = matrixEdit(edit.insert, edit.selection, "next")!;
    expect(next.selection.from).toBeGreaterThan(edit.selection.from);
    const row = matrixEdit(edit.insert, edit.selection, "addRow")!;
    const source = edit.insert.slice(0, row.from) + row.insert + edit.insert.slice(row.to);
    expect(matrixAt(source, row.selection.from)?.rows).toHaveLength(3);
  });
  it("never treats nested matrix delimiters as outer cells", () => {
    const source =
      "\\begin{pmatrix}a & \\begin{matrix}x&y\\\\z&w\\end{matrix}\\\\c&d\\end{pmatrix}";
    expect(matrixAt(source, source.indexOf("a &"))?.rows.map((row) => row.length)).toEqual([2, 2]);
    expect(matrixAt(source, source.indexOf("x&y"))?.environment).toBe("matrix");
  });
  it("refuses destructive changes to malformed, ruled or annotated matrices", () => {
    for (const body of ["x&y\\\\z", "x&y\\\\[2pt]z&w", "x&y% comment\n\\\\z&w", "\\hline x&y"]) {
      const source = `\\begin{matrix}${body}\\end{matrix}`;
      expect(matrixEdit(source, { from: 14, to: 14 }, "addRow")).toBeNull();
    }
  });
  it("bounds dimensions and keeps cases two-column", () => {
    expect(insertMatrix({ from: 0, to: 0 }, "pmatrix", 0, 3)).toBeNull();
    expect(insertMatrix({ from: 0, to: 0 }, "cases", 2, 3)).toBeNull();
  });
});
