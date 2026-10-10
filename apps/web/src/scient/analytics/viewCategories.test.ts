import { expect, it } from "vite-plus/test";
import { panelCategory, SETTINGS_ANALYTICS_SECTIONS, settingsCategory } from "./viewCategories";

// The server normalizes with the analytics contract and turns any section it
// does not name into "other"; the website gateway validates the same list.
// The web project does not depend on the analytics package, so the test loads
// the contract itself at run time (a computed path keeps it out of type-checking).
const WIRE_CONTRACT = new URL(
  "../../../../../packages/scient-analytics/src/wireContract.ts",
  import.meta.url,
).pathname;

async function contractSettingsSections(): Promise<readonly string[]> {
  const contract = (await import(/* @vite-ignore */ WIRE_CONTRACT)) as {
    readonly EVENT_DEFINITIONS: Record<
      string,
      { readonly properties: Record<string, { readonly values?: readonly string[] }> }
    >;
  };
  return contract.EVENT_DEFINITIONS["settings.viewed"]?.properties.section?.values ?? [];
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
it("reports every settings page by name, never as other", async () => {
  expect(settingsCategory("/settings/documents")).toBe("documents");
  expect(settingsCategory("/settings/storage")).toBe("storage");
  expect(SETTINGS_ANALYTICS_SECTIONS.size).toBeGreaterThan(10);
  const contract = await contractSettingsSections();
  expect(contract).toContain("other");
  for (const section of SETTINGS_ANALYTICS_SECTIONS) {
    expect(contract, `analytics contract names "${section}"`).toContain(section);
  }
});
