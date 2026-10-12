import { Extension } from "@tiptap/core";

// The shared capture dispatcher owns configurable formatting in prose and cells.
// Consume fixed bindings here so disabled/remapped commands cannot fall through.
export const LatexWritingKeys = Extension.create({
  name: "sharedWritingKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    return { "Mod-b": () => true, "Mod-i": () => true, "Mod-e": () => true };
  },
});
