// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { applyComposerDirection } from "./applyComposerDirection";

describe("composer content direction", () => {
  it.each(["rtl", "ltr"] as const)("applies %s and restores contextual direction", (direction) => {
    const surface = document.createElement("div");
    surface.className = "composer-editor-surface";
    const root = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Hello שלום";
    root.append(paragraph);
    surface.append(root);

    applyComposerDirection(root, direction);
    expect(surface.dataset.scientContentDirection).toBe(direction);
    expect(root.dir).toBe(direction);
    expect(paragraph.dir).toBe(direction);

    const newParagraph = document.createElement("p");
    root.append(newParagraph);
    applyComposerDirection(root, direction);
    expect(newParagraph.dir).toBe(direction);

    applyComposerDirection(root, "auto");
    expect(surface.hasAttribute("data-scient-content-direction")).toBe(false);
    expect(root.dir).toBe("ltr");
    expect(paragraph.dir).toBe("ltr");
    expect(newParagraph.dir).toBe("ltr");
    expect(paragraph.textContent).toBe("Hello שלום");
  });

  it("uses the whole draft as context while resolving paragraphs and complete lists", () => {
    const root = document.createElement("div");
    const hebrewParagraph = document.createElement("p");
    hebrewParagraph.textContent = "זהו מסמך עברי ארוך וברור מאוד ".repeat(4);
    const contextualParagraph = document.createElement("p");
    contextualParagraph.textContent = "abcd אב";
    const ltrParagraph = document.createElement("p");
    ltrParagraph.textContent = "abcdefghij א";
    const list = document.createElement("ul");
    list.innerHTML =
      "<li>Standard deviation and confidence interval</li><li>Review the complete report שלום</li>";
    root.append(hebrewParagraph, contextualParagraph, ltrParagraph, list);

    applyComposerDirection(root, "auto");

    expect(root.dir).toBe("rtl");
    expect(hebrewParagraph.dir).toBe("rtl");
    expect(contextualParagraph.dir).toBe("rtl");
    expect(ltrParagraph.dir).toBe("ltr");
    expect(list.dir).toBe("ltr");
    expect(list.querySelector("li")?.hasAttribute("dir")).toBe(false);
  });

  it("does not count inline code as prose", () => {
    const root = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.append("אבג ");
    const code = document.createElement("code");
    code.textContent = "const englishTechnicalIdentifier = true";
    paragraph.append(code);
    root.append(paragraph);

    applyComposerDirection(root, "auto");

    expect(root.dir).toBe("rtl");
    expect(paragraph.dir).toBe("rtl");
  });

  it("tolerates an unmounted editor and a root without a surrounding surface", () => {
    expect(() => applyComposerDirection(null, "rtl")).not.toThrow();
    const root = document.createElement("div");
    applyComposerDirection(root, "ltr");
    expect(root.dir).toBe("ltr");
    applyComposerDirection(root, "auto");
    expect(root.dir).toBe("ltr");
  });
});
