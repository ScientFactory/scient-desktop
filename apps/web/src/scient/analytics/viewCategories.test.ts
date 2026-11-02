import { expect, it } from "vite-plus/test";
import { panelCategory, SETTINGS_ANALYTICS_SECTIONS, settingsCategory } from "./viewCategories";

// The server sends a section name as it is when it looks like an identifier, and "other" otherwise.
const SENT_AS_IS = /^[A-Za-z0-9_.-]{1,64}$/u;

it("categorizes nested settings without transmitting identifiers", () => {
  expect(settingsCategory("/settings/providers/PRIVATE")).toBe("providers");
  expect(settingsCategory("/settings/PRIVATE")).toBe("other");
  expect(settingsCategory("/PRIVATE")).toBeNull();
});
it("never uses panel identity, path or titles as categories", () => {
  expect(
    panelCategory({
      id: "file:PRIVATE",
      kind: "file",
      relativePath: "PRIVATE",
      revealLine: null,
      revealRequestId: 0,
    }),
  ).toBe("file-preview");
  expect(panelCategory({ id: "browser:PRIVATE", kind: "preview", resourceId: "PRIVATE" })).toBe(
    "browser",
  );
  expect(
    panelCategory({
      id: "scient:compute:PRIVATE",
      kind: "scient",
      module: "compute",
      cwd: "PRIVATE",
    }),
  ).toBe("compute");
});
it("reports every settings page by name, never as other", () => {
  expect(settingsCategory("/settings/documents")).toBe("documents");
  expect(settingsCategory("/settings/maintenance")).toBe("storage");
  expect(SETTINGS_ANALYTICS_SECTIONS.size).toBeGreaterThan(10);
  for (const section of SETTINGS_ANALYTICS_SECTIONS) {
    expect(section, `settings section "${section}" is sent by name`).toMatch(SENT_AS_IS);
  }
});
