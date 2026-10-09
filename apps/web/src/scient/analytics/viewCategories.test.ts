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
/** The section values `settings.viewed` accepts, read from the contract with its comments removed. */
function contractSettingsSections(): readonly string[] {
  const code = wireContract.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  const event = code.slice(code.indexOf('"settings.viewed": {'), code.indexOf('"usage.viewed": {'));
  const values = /section:\s*\{[^}]*values:\s*\[([^\]]*)\]/u.exec(event)?.[1] ?? "";
  return [...values.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

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
  const contract = contractSettingsSections();
  expect(contract).toContain("other");
  for (const section of SETTINGS_ANALYTICS_SECTIONS) {
    expect(contract, `analytics contract names "${section}"`).toContain(section);
  }
});
