// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vite-plus/test";

import { latexGuidancePlaceholders } from "./latexGuidance";

it("keeps one guidance plugin across hot updates", () => {
  const editor = new Editor({ extensions: [StarterKit] });
  const count = () =>
    editor.state.plugins.filter((plugin) =>
      (plugin as unknown as { key: string }).key.startsWith("scientLatexGuidance$"),
    ).length;
  // Each hot update brings a new module, with a new key; the editor's refresh
  // removes the old plugin by name before adding the new one.
  for (let update = 0; update < 3; update++) {
    editor.unregisterPlugin("scientLatexGuidance");
    editor.registerPlugin(latexGuidancePlaceholders(() => null));
  }
  expect(count()).toBe(1);
  editor.destroy();
});
