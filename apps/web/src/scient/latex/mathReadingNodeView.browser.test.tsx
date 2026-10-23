import {
  render as _fixtureRender,
  type Screen,
  act,
  fakeTimers,
  stubGlobal,
} from "../../../test/render";
import { useLayoutEffect, useState, type ReactNode } from "react";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { MathfieldElement } from "mathlive";
import { NodeSelection } from "@tiptap/pm/state";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
const readiness = vi.hoisted(() => ({ hold: false }));
vi.mock("./mathFieldReadiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mathFieldReadiness")>();
  return {
    observeMathFieldReadiness: (...args: Parameters<typeof actual.observeMathFieldReadiness>) =>
      readiness.hold ? () => {} : actual.observeMathFieldReadiness(...args),
  };
});

import { LatexVisualEditor } from "./LatexVisualEditor";
import { readMountedLatexVisualTestEditor, useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { isMacKeyboard } from "../keyboard/keys";
import { clearVisualDraft } from "./visualDrafts";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { refreshMathReadingContext, type MathReadingNodeOptions } from "./mathReadingNodeView";
import { LatexReadingAnchor } from "./latexReadingAnchor";
import "./scient-latex.css";

const draftKey = "synthetic-math-reading-node-qualification";
const advanceAdmissionClock = async (ms = 32) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
};

async function focusOutsideOnPublication(reading: HTMLElement, outside: HTMLElement) {
  expect(reading.dataset.mathEditorAdmission).toBe("pending");
  let published = false;
  const observer = new MutationObserver(() => {
    if (reading.dataset.mathEditorAdmission === "pending") return;
    outside.focus();
    published = true;
  });
  observer.observe(reading, { attributes: true, attributeFilter: ["data-math-editor-admission"] });
  try {
    reading.querySelector<HTMLElement>("math-field")!.dataset.scientMathReady = "true";
    await vi.waitFor(() => expect(published).toBe(true));
  } finally {
    observer.disconnect();
  }
}

const readers = (_fixture: _Fixture) => [
  ..._fixture.host.querySelectorAll<HTMLElement>("[data-math-reading-view]"),
];
const editor = (_fixture: _Fixture) =>
  (_fixture.host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
const markup = (element: Element) =>
  element
    .querySelector(".scient-latex-math-preview")
    ?.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent;

/** Selects the formula at `index` without a click, as inserting one from a menu does. */
function selectFormula(_fixture: _Fixture, index: number) {
  const positions: number[] = [];
  editor(_fixture).state.doc.descendants((node, position) => {
    if (node.type.name === "latexInlineMath" || node.type.name === "latexDisplayMath")
      positions.push(position);
  });
  editor(_fixture).commands.setNodeSelection(positions[index]!);
}

async function _cleanupFixture0(_fixture: _Fixture) {
  readiness.hold = false;
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  clearVisualDraft(draftKey);
}

it.each([
  String.raw`Before $\frac{1}{\frac{x}{y}}$ after.`,
  String.raw`\begin{align}x&=y\\z&=w\end{align}`,
])(
  "keeps the original formula and page geometry visible through held editor readiness: %s",
  async (body) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    await mount(_fixture, body);
    const original = _fixture.source;
    const reading = readers(_fixture)[0]!;
    const preview = reading.querySelector<HTMLElement>(".scient-latex-math-preview")!;
    const ink = markup(reading);
    const before = reading.getBoundingClientRect();
    const rows = [...reading.querySelectorAll("[data-latex-equation-row]")];
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await vi.waitFor(async () => expect(reading.dataset.mathEditorAdmission).toBe("pending"));
    await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
    for (let paint = 0; paint < 8; paint++) {
      await advanceAdmissionClock();
      expect(preview.isConnected && !preview.hidden).toBe(true);
      expect(markup(reading)).toBe(ink);
      expect(Math.abs(reading.getBoundingClientRect().height - before.height)).toBeLessThan(1);
      expect(Math.abs(reading.getBoundingClientRect().width - before.width)).toBeLessThan(1);
      expect(rows.every((row) => row.isConnected)).toBe(true);
    }
    const field = reading.querySelector<MathfieldElement>("math-field")!;
    field.dataset.scientMathReady = "true";
    await vi.waitFor(async () => expect(reading.dataset.mathEditorAdmission).toBeUndefined());
    await vi.waitFor(async () => expect(field.hasFocus()).toBe(true));
    expect(preview.isConnected).toBe(false);
    expect(Math.abs(reading.getBoundingClientRect().height - before.height)).toBeLessThan(1);
    expect(_fixture.source).toBe(original);
    await advanceAdmissionClock();
    expect(document.activeElement).toBe(field);
    field.position = body.includes("align") ? 2 : field.lastOffset;
    await userEvent.keyboard("+q");
    expect(field.getValue()).toContain("q");
    await vi.waitFor(async () => expect(_fixture.source).not.toBe(original));
    await userEvent.keyboard("{Control>}z{/Control}");
    await vi.waitFor(async () => expect(_fixture.source).toBe(original));
  },
);

it("cancels held admission on a newer outside focus intent and leaves the reading ink intact", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const original = _fixture.source;
  const reading = readers(_fixture)[0]!;
  const ink = markup(reading);
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  const outside = document.createElement("button");
  outside.textContent = "Other action";
  outside.style.cssText = "position:fixed;right:8px;top:8px;z-index:99999";
  document.body.append(outside);
  try {
    await userEvent.click(outside);
    await advanceAdmissionClock();
    expect(reading.querySelector("math-field")).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(markup(reading)).toBe(ink);
    expect(_fixture.source).toBe(original);
  } finally {
    outside.remove();
  }
});

it("protects the pending equation from typing, IME, paste and drop without changing source", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const original = _fixture.source;
  const model = editor(_fixture).state.doc;
  const reading = readers(_fixture)[0]!;
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  expect(document.activeElement).toBe(reading.querySelector("[data-node-view-wrapper]"));
  expect((document.activeElement as HTMLElement).isContentEditable).toBe(false);
  const data = new DataTransfer();
  data.setData("text/plain", "replacement");
  const events = [
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
    new CompositionEvent("compositionstart", { data: "字", bubbles: true, cancelable: true }),
    new InputEvent("beforeinput", {
      data: "字",
      inputType: "insertCompositionText",
      bubbles: true,
      cancelable: true,
    }),
  ];
  for (const event of events) {
    editor(_fixture).view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  await userEvent.keyboard("q");
  await advanceAdmissionClock();
  expect(_fixture.source).toBe(original);
  expect(editor(_fixture).state.doc).toBe(model);
  document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
  editor(_fixture).commands.setTextSelection(2);
  await advanceAdmissionClock();
  expect(reading.querySelector("math-field")).toBeNull();
});

it("types what was typed while the equation editor was prepared once it is ready", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const reading = readers(_fixture)[0]!;
  readiness.hold = true;
  // Selected without a click, as a formula just inserted from the Math menu is.
  selectFormula(_fixture, 0);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  expect(reading.dataset.mathEditorAdmission).toBe("pending");
  await userEvent.keyboard("qw{Backspace}z");
  await advanceAdmissionClock();
  expect(_fixture.source).not.toContain("qz");
  const field = reading.querySelector<MathfieldElement>("math-field")!;
  field.dataset.scientMathReady = "true";
  await vi.waitFor(async () => expect(field.hasFocus()).toBe(true));
  await vi.waitFor(async () => expect(field.getValue()).toContain("qz"));
  expect(field.getValue()).not.toContain("w");
  await vi.waitFor(async () => expect(_fixture.source).toContain("qz"));
});

it("types kept keys exactly as typing into a ready editor", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x$ and $x$ after.");
  // A command, brackets, scripts, spaces and a mistyped letter removed again.
  const keys = "\\alpha (a^2_1) qw{Backspace}z";
  const [first, second] = readers(_fixture);
  const type = async (reading: HTMLElement, index: number, held: boolean) => {
    readiness.hold = held;
    selectFormula(_fixture, index);
    await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
    const field = reading.querySelector<MathfieldElement>("math-field")!;
    if (held) {
      expect(reading.dataset.mathEditorAdmission).toBe("pending");
      await userEvent.keyboard(keys);
      field.dataset.scientMathReady = "true";
    }
    await vi.waitFor(async () => expect(field.hasFocus()).toBe(true));
    if (!held) await userEvent.keyboard(keys);
    await vi.waitFor(async () => expect(field.getValue()).toContain("qz"));
    return field.getValue();
  };
  const kept = await type(first!, 0, true);
  editor(_fixture).commands.setTextSelection(1);
  await advanceAdmissionClock();
  const typed = await type(second!, 1, false);
  expect(kept).toBe(typed);
});

it("deletes nothing in the formula for a Backspace typed while its editor was prepared", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const reading = readers(_fixture)[0]!;
  readiness.hold = true;
  selectFormula(_fixture, 0);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  await userEvent.keyboard("q{Backspace}{Backspace}{Backspace}");
  const field = reading.querySelector<MathfieldElement>("math-field")!;
  field.dataset.scientMathReady = "true";
  await vi.waitFor(async () => expect(field.hasFocus()).toBe(true));
  await advanceAdmissionClock();
  expect(field.getValue()).toBe("x+y");
});

it("keeps no keys typed after a click while the equation editor was prepared", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const reading = readers(_fixture)[0]!;
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  await userEvent.keyboard("q");
  const field = reading.querySelector<MathfieldElement>("math-field")!;
  field.dataset.scientMathReady = "true";
  await vi.waitFor(async () => expect(field.hasFocus()).toBe(true));
  await advanceAdmissionClock();
  // The click's caret and selection belong to the relayed gesture.
  expect(field.getValue()).toBe("x+y");
});

it("keeps no composing key typed while the equation editor was prepared", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const reading = readers(_fixture)[0]!;
  readiness.hold = true;
  selectFormula(_fixture, 0);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  const composing = new KeyboardEvent("keydown", {
    key: "n",
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  document.activeElement!.dispatchEvent(composing);
  expect(composing.defaultPrevented).toBe(true);
  const field = reading.querySelector<MathfieldElement>("math-field")!;
  field.dataset.scientMathReady = "true";
  await vi.waitFor(async () => expect(field.hasFocus()).toBe(true));
  await advanceAdmissionClock();
  expect(field.getValue()).toBe("x+y");
});

it("retires fallback reading measurements through their original timer owner when idle APIs change", () => {
  // This editor has no paged planner: its real blocks use the reading anchor's idle measurement.
  using _clock = fakeTimers();
  const requestIdle = window.requestIdleCallback;
  using _withoutIdle = stubGlobal("requestIdleCallback", undefined);
  using cleanup = new DisposableStack();
  const host = document.createElement("div");
  document.body.append(host);
  cleanup.defer(() => host.remove());
  const owner = new Editor({
    element: host,
    extensions: [StarterKit, LatexReadingAnchor],
    content: "<p>Unchanged reading text.</p>",
  });
  cleanup.defer(() => {
    if (!owner.isDestroyed) owner.destroy();
  });
  const block = owner.view.dom.firstElementChild!;
  const original = block.outerHTML;
  const changes = vi.fn();
  owner.on("update", changes);

  vi.advanceTimersToNextFrame();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  expect(block.hasAttribute("data-latex-measure")).toBe(false);

  // Newly available idle APIs must not take ownership of an existing fallback timeout.
  using _idleAvailable = stubGlobal("requestIdleCallback", requestIdle);
  owner.destroy();
  expect(owner.isDestroyed).toBe(true);
  vi.runAllTimers();
  expect(block.outerHTML).toBe(original);
  expect(changes).not.toHaveBeenCalled();
});

it("closes the document while a formula is being edited without a late write", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x$ and $x$ after.");
  const [first, second] = readers(_fixture);
  const errors: unknown[] = [];
  // Chrome's benign resize-loop notice is not an error of this page.
  const caught = (event: ErrorEvent) => {
    if (!event.message.includes("ResizeObserver loop")) errors.push(event.error ?? event.message);
  };
  const rejected = (event: PromiseRejectionEvent) => errors.push(event.reason);
  window.addEventListener("error", caught);
  window.addEventListener("unhandledrejection", rejected);
  try {
    for (const reading of [first!, second!]) {
      const target = reading.querySelector<HTMLElement>(".scient-latex-mathfield")!;
      const box = target.getBoundingClientRect();
      await userEvent.click(target, { position: { x: box.width - 2, y: box.height / 2 } });
      await vi.waitFor(async () =>
        expect(reading.querySelector<MathfieldElement>("math-field")?.hasFocus()).toBe(true),
      );
      const field = reading.querySelector<MathfieldElement>("math-field")!;
      await userEvent.keyboard("\\alpha (a^2_1) q");
      await vi.waitFor(async () => expect(field.getValue()).toContain("q"));
      if (reading === first) {
        editor(_fixture).commands.setTextSelection(1);
        await advanceAdmissionClock();
      }
    }
    // Closing while the second formula is still being edited.
    await _fixture.root0.rerender(null);
    await advanceAdmissionClock(1500);
    expect(errors).toEqual([]);
  } finally {
    window.removeEventListener("error", caught);
    window.removeEventListener("unhandledrejection", rejected);
  }
});

it("preserves an outside focus change immediately after publication through MathLive's delayed focus", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const original = _fixture.source;
  const reading = readers(_fixture)[0]!;
  const outside = document.createElement("button");
  outside.textContent = "New focus";
  document.body.append(outside);
  try {
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
    await focusOutsideOnPublication(reading, outside);

    await advanceAdmissionClock(250);
    expect(document.activeElement).toBe(outside);
    expect(_fixture.source).toBe(original);
  } finally {
    outside.remove();
  }
});

it("lets a new user click return to math during the initial outside-focus guard", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const original = _fixture.source;
  const reading = readers(_fixture)[0]!;
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
    const math = reading.querySelector<MathfieldElement>("math-field")!;
    await focusOutsideOnPublication(reading, outside);

    await userEvent.click(math);
    await advanceAdmissionClock(200);
    expect(document.activeElement).toBe(math);
    expect(_fixture.source).toBe(original);
  } finally {
    outside.remove();
  }
});

it.each(["selection", "readonly", "source"])(
  "cancels delayed publication after a newer %s change",
  async (change) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    await mount(_fixture, "Before $x+y$ after.");
    const original = _fixture.source;
    const reading = readers(_fixture)[0]!;
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
    await act(() => {
      if (change === "selection") editor(_fixture).commands.setTextSelection(2);
      else if (change === "readonly") _fixture.setDisabled(true);
      else _fixture.replace(original.replace("x+y", "z+w"));
    });
    await vi.waitFor(async () =>
      expect(_fixture.host.querySelector("[data-math-editor-staging]")).toBeNull(),
    );
    expect(_fixture.host.querySelector("math-field")).toBeNull();
    expect(_fixture.source).toBe(change === "source" ? original.replace("x+y", "z+w") : original);
  },
);

it("leaves readable ink and Retry when an editor never becomes ready", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.");
  const original = _fixture.source;
  const reading = readers(_fixture)[0]!;
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await vi.waitFor(async () => expect(reading.querySelector("button")?.textContent).toBe("Retry"), {
    timeout: 6000,
  });
  expect(reading.querySelector("math-field")).toBeNull();
  expect(markup(reading)).toContain("x");
  expect(_fixture.source).toBe(original);
});

it("refreshes passive ink after context cancellation and retries a failed editor without a stale hint", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, String.raw`Before $\foo$ after.`, String.raw`\newcommand{\foo}{x}`);
  const original = _fixture.source;
  const reading = readers(_fixture)[0]!;
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  const extension = editor(_fixture).extensionManager.extensions.find(
    (extension) => extension.name === "latexInlineMath",
  )!;
  const context = (extension.options as MathReadingNodeOptions).readingContext!();
  const previous = context.macros;
  try {
    Object.assign(context, { macros: { ...previous, foo: "z" } });
    refreshMathReadingContext(editor(_fixture));
    await vi.waitFor(async () => expect(markup(reading)).toContain("z"));
    expect(reading.querySelector("math-field")).toBeNull();
  } finally {
    Object.assign(context, { macros: previous });
    refreshMathReadingContext(editor(_fixture));
  }
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await vi.waitFor(async () => expect(reading.querySelector("math-field")).toBeTruthy());
  reading.querySelector<HTMLElement>("math-field")!.dataset.scientMathReady = "failed";
  await vi.waitFor(async () => expect(reading.querySelector("button")?.textContent).toBe("Retry"));
  expect(markup(reading)).toContain("x");
  expect(_fixture.source).toBe(original);
  readiness.hold = false;
  await userEvent.click(reading.querySelector<HTMLButtonElement>("button")!);
  await vi.waitFor(async () =>
    expect(reading.querySelector<MathfieldElement>("math-field")?.hasFocus()).toBe(true),
  );
  expect(reading.querySelector(".scient-latex-math-admission-hint")).toBeNull();
  expect(_fixture.source).toBe(original);
});

async function mount(_fixture: _Fixture, body: string, preamble = "") {
  await page.viewport(1400, 900);
  _fixture.publishSource(
    `\\documentclass{article}\n\\usepackage{amsmath}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}`,
  );
  clearVisualDraft(draftKey);
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText =
    "width:1200px;height:850px;position:relative;background:white;color:black";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  function Harness() {
    const [text, setText] = useState(_fixture.source);
    const owner = useLatexVisualTestOwner(text);
    const [disabled, updateDisabled] = useState(false);
    useLayoutEffect(() => {
      _fixture.publishReplace((next) => {
        _fixture.publishSource(next);
        setText(next);
      });
      _fixture.publishSetDisabled(updateDisabled);
    }, []);
    return (
      <LatexVisualEditor
        draftKey={draftKey}
        fileRevision="synthetic-r1"
        source={text}
        sourceSnapshot={owner.snapshot}
        disabled={disabled}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === _fixture.source);
          if (outcome.accepted) _fixture.replace(outcome.snapshot.source);
          return outcome;
        }}
      />
    );
  }
  await _fixture.root0.rerender(<Harness />);
  await vi.waitFor(() => expect(readMountedLatexVisualTestEditor(_fixture.host)).not.toBeNull());
  await vi.waitFor(async () => expect(readers(_fixture).length).toBeGreaterThan(0));
  await vi.waitFor(
    async () =>
      expect(
        readers(_fixture).every((element) =>
          mathReadingPreviewReady(element.querySelector(".scient-latex-math-preview")!),
        ),
      ).toBe(true),
    { timeout: 10000 },
  );
  await document.fonts.ready;
  _fixture.clock ??= _fixture.cleanup.use(fakeTimers());
  await advanceAdmissionClock();
}

it("reads many formulas without live editors and retains document selection", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(
    _fixture,
    Array.from({ length: 64 }, (_, i) => `Paragraph ${i}: $x_${i}+y$.`).join("\n\n"),
  );
  const original = _fixture.source;
  expect(readers(_fixture)).toHaveLength(64);
  expect(_fixture.host.querySelectorAll("math-field")).toHaveLength(0);
  expect(readers(_fixture).every((element) => markup(element)?.includes("x"))).toBe(true);
  editor(_fixture).commands.selectAll();
  await advanceAdmissionClock();
  expect(_fixture.host.querySelectorAll("[data-document-selected]")).toHaveLength(64);
  expect(_fixture.host.querySelectorAll("math-field")).toHaveLength(0);
  expect(_fixture.source).toBe(original);
});

it("the first click enters only its formula and native typing can be undone", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $a+b+c+d+e+f+g+h$ after.\n\n\\[u+v\\]");
  const original = _fixture.source;
  const field = readers(_fixture)[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!;
  await userEvent.click(field);
  await vi.waitFor(async () =>
    expect(_fixture.host.querySelector<MathfieldElement>("math-field")?.hasFocus()).toBe(true),
  );
  const math = _fixture.host.querySelector<MathfieldElement>("math-field")!;
  await advanceAdmissionClock();
  expect(readers(_fixture)).toHaveLength(1);
  expect(_fixture.host.querySelectorAll("math-field")).toHaveLength(1);
  expect(
    [..._fixture.host.querySelectorAll(".scient-latex-math-preview")].every(
      (preview) => preview.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent,
    ),
  ).toBe(true);
  // A click in the middle must place the caret there rather than at the end.
  expect(math.position).toBeLessThan(math.lastOffset);
  expect(editor(_fixture).state.selection).toBeInstanceOf(NodeSelection);
  await userEvent.keyboard("q");
  await vi.waitFor(async () => expect(_fixture.source).toContain("q"));
  await userEvent.keyboard("{Control>}z{/Control}");
  await vi.waitFor(async () => expect(_fixture.source).toBe(original));
  expect(math.hasFocus()).toBe(true);
});

it("macro-only changes and numbering refresh passive views without rewriting source", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(
    _fixture,
    "Before.\n\n\\begin{equation}\\readingmacro+y\\end{equation}\n\n\\begin{equation}z\\end{equation}",
    "\\newcommand{\\readingmacro}{x}",
  );
  expect(readers(_fixture).map(markup)[0]).toContain("x");
  expect(
    [..._fixture.host.querySelectorAll("[data-latex-equation-row]")].map(
      (element) => element.textContent,
    ),
  ).toEqual(["(1)", "(2)"]);
  const next = _fixture.source.replace("{\\readingmacro}{x}", "{\\readingmacro}{w}");
  await act(() => _fixture.replace(next));
  await vi.waitFor(async () => expect(readers(_fixture).map(markup)[0]).toContain("w"));
  expect(_fixture.source).toBe(next);
  expect(_fixture.host.querySelectorAll("math-field")).toHaveLength(0);
  const current = editor(_fixture);
  let first = -1;
  current.state.doc.forEach((node, position) => {
    if (first < 0 && node.type.name === "latexDisplayMath") first = position;
  });
  current.view.dispatch(
    current.state.tr.delete(first, first + current.state.doc.nodeAt(first)!.nodeSize),
  );
  await vi.waitFor(async () =>
    expect(
      [..._fixture.host.querySelectorAll("[data-latex-equation-row]")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["(1)"]),
  );
  expect(_fixture.host.querySelectorAll("math-field")).toHaveLength(0);
});

it("read-only formulas stay readable and become editable when enabled", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before $x+y$ after.\n\n\\[z^2\\]");
  const original = _fixture.source;
  _fixture.setDisabled(true);
  await vi.waitFor(async () => expect(editor(_fixture).isEditable).toBe(false));
  await userEvent.click(
    readers(_fixture)[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!,
  );
  await advanceAdmissionClock();
  expect(readers(_fixture)).toHaveLength(2);
  expect(_fixture.host.querySelectorAll("math-field")).toHaveLength(0);
  expect(_fixture.source).toBe(original);
  _fixture.setDisabled(false);
  await vi.waitFor(async () => expect(editor(_fixture).isEditable).toBe(true));
  await userEvent.click(
    readers(_fixture)[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!,
  );
  await vi.waitFor(async () =>
    expect(_fixture.host.querySelector<MathfieldElement>("math-field")?.hasFocus()).toBe(true),
  );
  expect(_fixture.source).toBe(original);
});

it("clicking beside a display returns to prose without initializing math", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "Before.\n\n\\[x+y\\]\n\nAfter.");
  const original = _fixture.source;
  const wrapper = readers(_fixture)[0]!.querySelector<HTMLElement>(
    ".scient-latex-visual-display-math",
  )!;
  const bounds = wrapper.getBoundingClientRect();
  wrapper.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      composed: true,
      button: 0,
      clientX: bounds.right - 2,
      clientY: (bounds.top + bounds.bottom) / 2,
    }),
  );
  await advanceAdmissionClock();
  expect(editor(_fixture).state.selection).not.toBeInstanceOf(NodeSelection);
  expect(_fixture.host.querySelectorAll("math-field")).toHaveLength(0);
  await userEvent.keyboard("q");
  // Slow runners have exceeded the 1 s default here.
  await vi.waitFor(async () => expect(_fixture.source).toContain("qAfter."), {
    timeout: 5000,
  });
  await userEvent.keyboard(isMacKeyboard() ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}");
  await vi.waitFor(async () => expect(_fixture.source).toBe(original));
});

it("equation tags return to the single-row position after an external row change", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const aligned = String.raw`\begin{align}x&=y\\z&=w\end{align}`;
  await mount(_fixture, `Before.\n\n${aligned}`);
  await vi.waitFor(async () =>
    expect(_fixture.host.querySelectorAll("[data-latex-equation-row]").length).toBe(2),
  );
  await userEvent.click(
    readers(_fixture)[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!,
  );
  await vi.waitFor(async () =>
    expect(_fixture.host.querySelector<MathfieldElement>("math-field")?.hasFocus()).toBe(true),
  );
  await vi.waitFor(async () =>
    expect(
      _fixture.host.querySelector<HTMLElement>("[data-latex-equation-row]")?.style.top,
    ).not.toBe(""),
  );
  const next = _fixture.source.replace(aligned, String.raw`\begin{equation}u=v\end{equation}`);
  await act(() => _fixture.replace(next));
  await vi.waitFor(async () =>
    expect(_fixture.host.querySelectorAll("[data-latex-equation-row]").length).toBe(1),
  );
  // The tag sits on the formula's baseline, as amsmath sets it: where a freshly
  // opened single equation puts it, not where the first aligned row was.
  const offset = () => {
    const row = _fixture.host.querySelector<HTMLElement>("[data-latex-equation-row]")!;
    const formula = row.closest<HTMLElement>(".scient-latex-visual-display-math")!;
    return row.getBoundingClientRect().top - formula.getBoundingClientRect().top;
  };
  await advanceAdmissionClock(128);
  const changed = offset();
  expect(_fixture.source).toBe(next);
  _fixture.clock?.[Symbol.dispose]();
  _fixture.clock = undefined;
  await _fixture.root0.unmount();
  _fixture.host.remove();
  await mount(_fixture, `Before.\n\n${String.raw`\begin{equation}u=v\end{equation}`}`);
  await vi.waitFor(async () =>
    expect(_fixture.host.querySelectorAll("[data-latex-equation-row]").length).toBe(1),
  );
  // Edited the same way: the field is open in both.
  await userEvent.click(
    readers(_fixture)[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!,
  );
  await vi.waitFor(async () =>
    expect(_fixture.host.querySelector<MathfieldElement>("math-field")?.hasFocus()).toBe(true),
  );
  await advanceAdmissionClock(128);
  expect(Math.abs(changed - offset())).toBeLessThan(1);
});

function _createFixture() {
  let _published_replace = undefined! as (source: string) => void;
  let _published_source = undefined! as string;
  let _published_setDisabled = undefined! as (disabled: boolean) => void;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get source() {
      return _published_source;
    },
    publishSource(next: typeof _published_source) {
      _published_source = next;
      return next;
    },
    get replace() {
      return _published_replace;
    },
    publishReplace(next: typeof _published_replace) {
      _published_replace = next;
      return next;
    },
    get setDisabled() {
      return _published_setDisabled;
    },
    publishSetDisabled(next: typeof _published_setDisabled) {
      _published_setDisabled = next;
      return next;
    },

    host: undefined! as HTMLDivElement,
    stack,
    clock: undefined as Disposable | undefined,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
