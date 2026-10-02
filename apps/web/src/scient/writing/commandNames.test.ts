// @effect-diagnostics nodeBuiltinImport:off -- Static audit of the shared command names.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { WRITING_COMMAND_LABELS, WRITING_COMMANDS_KEEPING_ICON_WEIGHT } from "./commandNames";

const read = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");

/** Every place that shows a shared writing command to the writer. */
const SURFACES = {
  "the Markdown bar": read("../markdownEditor/ui/ScientMarkdownControls.tsx"),
  "the Markdown slash menu": read("../markdownEditor/prosemirror/commands.ts"),
  "the LaTeX writing row": read("../latex/LatexVisualEditor.tsx"),
  "the shared Insert menu": read("./InsertMenu.tsx"),
};

describe("shared writing command names", () => {
  it("gives every shared command one distinct name", () => {
    const labels = Object.values(WRITING_COMMAND_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    for (const id of WRITING_COMMANDS_KEEPING_ICON_WEIGHT)
      expect(WRITING_COMMAND_LABELS[id]).toBeDefined();
  });

  it.each(Object.entries(SURFACES))(
    "%s takes those names from the shared list",
    (_name, source) => {
      expect(source).toContain("WRITING_COMMAND_LABELS");
      for (const label of Object.values(WRITING_COMMAND_LABELS)) {
        // A shared name written out again is how two editors drift apart: as a
        // label, as an accessible name, with an ellipsis, or as menu text.
        expect(source, label).not.toMatch(
          new RegExp(`(?:label|aria-label)[=:]\\s*\\{?["\`]${label}…?["\`]`, "u"),
        );
        expect(source, label).not.toMatch(new RegExp(`>\\s*${label}\\s*</`, "u"));
      }
    },
  );

  it("keeps the names the editors once disagreed on from coming back", () => {
    for (const [name, source] of Object.entries(SURFACES)) {
      for (const stale of ["Bulleted list", "Insert block or element", "Remove list formatting"])
        expect(source, `${name}: ${stale}`).not.toContain(stale);
    }
  });
});
