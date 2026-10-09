// @effect-diagnostics nodeBuiltinImport:off -- Static audit that the analytics contract names every settings page.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";
import { panelCategory, SETTINGS_ANALYTICS_SECTIONS, settingsCategory } from "./viewCategories";

// The server normalizes with the analytics contract and turns any section it
// does not name into "other"; the website gateway validates the same list.
const wireContract = NodeFS.readFileSync(
  new URL("../../../../../packages/scient-analytics/src/wireContract.ts", import.meta.url),
  "utf8",
);
const settingsViewed = wireContract.slice(
  wireContract.indexOf('"settings.viewed": {'),
  wireContract.indexOf('"usage.viewed": {'),
);

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
  expect(settingsCategory("/settings/storage")).toBe("storage");
  expect(SETTINGS_ANALYTICS_SECTIONS.size).toBeGreaterThan(10);
  for (const section of SETTINGS_ANALYTICS_SECTIONS) {
    expect(settingsViewed, `analytics contract names "${section}"`).toContain(`"${section}",`);
  }
});
