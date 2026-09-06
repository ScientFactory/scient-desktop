import { expect, it } from "vite-plus/test";
import { panelCategory, settingsCategory } from "./viewCategories";

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
