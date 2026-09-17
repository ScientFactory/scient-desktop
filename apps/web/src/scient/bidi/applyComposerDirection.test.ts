// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { applyComposerDirection } from "./applyComposerDirection";

describe("composer content direction", () => {
  it.each(["rtl", "ltr"] as const)("applies %s and restores automatic direction", (direction) => {
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
    expect(root.hasAttribute("dir")).toBe(false);
    expect(paragraph.dir).toBe("auto");
    expect(newParagraph.dir).toBe("auto");
    expect(paragraph.textContent).toBe("Hello שלום");
  });

  it("tolerates an unmounted editor and a root without a surrounding surface", () => {
    expect(() => applyComposerDirection(null, "rtl")).not.toThrow();
    const root = document.createElement("div");
    applyComposerDirection(root, "ltr");
    expect(root.dir).toBe("ltr");
    applyComposerDirection(root, "auto");
    expect(root.hasAttribute("dir")).toBe(false);
  });
});
