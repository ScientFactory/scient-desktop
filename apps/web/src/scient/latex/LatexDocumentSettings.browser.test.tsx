import { render as _fixtureRender, type Screen } from "../../../test/render";
import { useLayoutEffect, useState } from "react";

import { expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { LatexDocumentSettings } from "./LatexDocumentSettings";
import { updateLatexDocumentSettingsSource } from "./latexDocumentSettingsSource";
import { latexDocumentLanguage } from "./latexLanguage";
import "~/index.css";
import "./scient-latex.css";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

async function mount(_fixture: _Fixture, preamble = "", disabled = false, viewport = 900) {
  await page.viewport(viewport, 800);
  _fixture.publishSource(
    `\\documentclass[11pt,a4paper]{article}\n${preamble}\\begin{document}\nExisting body.\n\\end{document}\n`,
  );
  _fixture.publishApplyCount(0);
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText =
    "width:min(384px,calc(100vw - 32px));padding:4px;background:var(--popover);";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  function Harness() {
    const [text, setText] = useState(_fixture.source);
    useLayoutEffect(() => {
      _fixture.publishSetExternalSource(setText);
    });
    return (
      <LatexDocumentSettings
        source={text}
        disabled={disabled}
        onOpenChange={() => {}}
        onOpenSource={() => {}}
        onApply={(changes, expected) => {
          if (expected !== _fixture.source) return false;
          const next = updateLatexDocumentSettingsSource(_fixture.source, changes);
          if (next === null) return false;
          _fixture.publishSource(next);
          _fixture.postIncrementApplyCount();
          setText(next);
          return true;
        }}
      />
    );
  }
  await _fixture.root0.rerender(<Harness />);
  await expect.element(page.getByRole("combobox", { name: "Document language" })).toBeVisible();
}

async function chooseLanguage(name: "English" | "Hebrew") {
  await page.getByRole("combobox", { name: "Document language" }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

it.each([900, 320])("fits the approved three/two/two layout at viewport %s", async (viewport) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, "", false, viewport);
  const box = (label: string) =>
    _fixture.host!.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.getBoundingClientRect();
  const type = box("Document type");
  const size = box("Text size");
  const paper = box("Paper size");
  const language = box("Document language");
  const orientation = box("Orientation");
  const margins = box("Margins");
  const paragraphs = box("Paragraphs");
  expect(Math.abs(type.top - size.top)).toBeLessThan(1);
  expect(Math.abs(size.top - paper.top)).toBeLessThan(1);
  expect(Math.abs(type.width - size.width)).toBeLessThan(1);
  expect(Math.abs(size.width - paper.width)).toBeLessThan(1);
  expect(Math.abs(language.top - orientation.top)).toBeLessThan(1);
  expect(Math.abs(margins.top - paragraphs.top)).toBeLessThan(1);
  expect(language.top).toBeGreaterThan(type.bottom);
  expect(margins.top).toBeGreaterThan(language.bottom);
  const bounds = _fixture.host!.getBoundingClientRect();
  for (const control of [type, size, paper, language, orientation, margins, paragraphs]) {
    expect(control.left).toBeGreaterThanOrEqual(bounds.left);
    expect(control.right).toBeLessThanOrEqual(bounds.right);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport);
});

it("stages language, clears a reverted choice, and publishes only on Apply", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture);
  const original = _fixture.source;
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  await expect.element(apply).toBeDisabled();
  await chooseLanguage("Hebrew");
  expect(_fixture.source).toBe(original);
  expect(_fixture.applyCount).toBe(0);
  await expect.element(apply).toBeEnabled();
  await chooseLanguage("English");
  await expect.element(apply).toBeDisabled();
  await chooseLanguage("Hebrew");
  await apply.click();
  expect(_fixture.applyCount).toBe(1);
  expect(latexDocumentLanguage(_fixture.source).main).toBe("hebrew");
  expect(_fixture.source).toContain("Existing body.");
});

it("refuses a staged change after the working source changes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture);
  await chooseLanguage("Hebrew");
  _fixture.setExternalSource!(_fixture.source + "% external edit\n");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "The document changed while settings were open. Close and reopen settings to use the latest version.",
    );
  await expect.element(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  expect(_fixture.applyCount).toBe(0);
});

it.each([
  { preamble: "\\usepackage[english,hebrew]{babel}\n", disabled: false },
  { preamble: "", disabled: true },
])(
  "keeps unsupported or read-only language controls disabled: %j",
  async ({ preamble, disabled }) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    await mount(_fixture, preamble, disabled);
    await expect.element(page.getByRole("combobox", { name: "Document language" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  },
);

function _createFixture() {
  let _published_setExternalSource = undefined! as ((source: string) => void) | undefined;
  let _published_source = "";
  let _published_applyCount = 0;

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
    get applyCount() {
      return _published_applyCount;
    },
    publishApplyCount(next: typeof _published_applyCount) {
      _published_applyCount = next;
      return next;
    },
    postIncrementApplyCount() {
      return _published_applyCount++;
    },
    get setExternalSource() {
      return _published_setExternalSource;
    },
    publishSetExternalSource(next: typeof _published_setExternalSource) {
      _published_setExternalSource = next;
      return next;
    },

    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
