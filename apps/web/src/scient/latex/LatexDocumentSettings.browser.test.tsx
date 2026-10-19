import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { LatexDocumentSettings } from "./LatexDocumentSettings";
import { updateLatexDocumentSettingsSource } from "./latexDocumentSettingsSource";
import { latexDocumentLanguage } from "./latexLanguage";
import "~/index.css";
import "./scient-latex.css";

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let source = "";
let applyCount = 0;
let setExternalSource: ((source: string) => void) | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

async function mount(preamble = "", disabled = false, viewport = 900) {
  await page.viewport(viewport, 800);
  source = `\\documentclass[11pt,a4paper]{article}\n${preamble}\\begin{document}\nExisting body.\n\\end{document}\n`;
  applyCount = 0;
  host = document.createElement("div");
  host.style.cssText = "width:min(384px,calc(100vw - 32px));padding:4px;background:var(--popover);";
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const [text, setText] = useState(source);
    setExternalSource = setText;
    return (
      <LatexDocumentSettings
        source={text}
        disabled={disabled}
        onOpenChange={() => {}}
        onOpenSource={() => {}}
        onApply={(changes, expected) => {
          if (expected !== source) return false;
          const next = updateLatexDocumentSettingsSource(source, changes);
          if (next === null) return false;
          source = next;
          applyCount++;
          setText(next);
          return true;
        }}
      />
    );
  }
  root.render(<Harness />);
  await expect.element(page.getByRole("combobox", { name: "Document language" })).toBeVisible();
}

async function chooseLanguage(name: "English" | "Hebrew") {
  await page.getByRole("combobox", { name: "Document language" }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

it.each([900, 320])("fits the approved three/two/two layout at viewport %s", async (viewport) => {
  await mount("", false, viewport);
  const box = (label: string) =>
    host!.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.getBoundingClientRect();
  const type = box("Document type"),
    size = box("Text size"),
    paper = box("Paper size");
  const language = box("Document language"),
    orientation = box("Orientation");
  const margins = box("Margins"),
    paragraphs = box("Paragraphs");
  expect(Math.abs(type.top - size.top)).toBeLessThan(1);
  expect(Math.abs(size.top - paper.top)).toBeLessThan(1);
  expect(Math.abs(type.width - size.width)).toBeLessThan(1);
  expect(Math.abs(size.width - paper.width)).toBeLessThan(1);
  expect(Math.abs(language.top - orientation.top)).toBeLessThan(1);
  expect(Math.abs(margins.top - paragraphs.top)).toBeLessThan(1);
  expect(language.top).toBeGreaterThan(type.bottom);
  expect(margins.top).toBeGreaterThan(language.bottom);
  const bounds = host!.getBoundingClientRect();
  for (const control of [type, size, paper, language, orientation, margins, paragraphs]) {
    expect(control.left).toBeGreaterThanOrEqual(bounds.left);
    expect(control.right).toBeLessThanOrEqual(bounds.right);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport);
});

it("stages language, clears a reverted choice, and publishes only on Apply", async () => {
  await mount();
  const original = source;
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  await expect.element(apply).toBeDisabled();
  await chooseLanguage("Hebrew");
  expect(source).toBe(original);
  expect(applyCount).toBe(0);
  await expect.element(apply).toBeEnabled();
  await chooseLanguage("English");
  await expect.element(apply).toBeDisabled();
  await chooseLanguage("Hebrew");
  await apply.click();
  expect(applyCount).toBe(1);
  expect(latexDocumentLanguage(source).main).toBe("hebrew");
  expect(source).toContain("Existing body.");
});

it("refuses a staged change after the working source changes", async () => {
  await mount();
  await chooseLanguage("Hebrew");
  setExternalSource!(source + "% external edit\n");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "The document changed while settings were open. Close and reopen settings to use the latest version.",
    );
  await expect.element(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  expect(applyCount).toBe(0);
});

it.each([
  { preamble: "\\usepackage[english,hebrew]{babel}\n", disabled: false },
  { preamble: "", disabled: true },
])(
  "keeps unsupported or read-only language controls disabled: %j",
  async ({ preamble, disabled }) => {
    await mount(preamble, disabled);
    await expect.element(page.getByRole("combobox", { name: "Document language" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  },
);
