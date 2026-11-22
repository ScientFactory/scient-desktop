import { expect, it } from "vite-plus/test";
import { SETTINGS_SECTION_LABELS } from "~/components/settings/settingsSearch";
import type { RightPanelSurface } from "~/rightPanelStore";
import { panelCategory, panelViewProperties, settingsCategory } from "./viewCategories";

type RightPanelFileAttachment = NonNullable<
  Extract<RightPanelSurface, { kind: "file" }>["attachment"]
>;

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
  const paths = Object.keys(SETTINGS_SECTION_LABELS);
  expect(paths.length).toBeGreaterThan(10);
  for (const path of paths) {
    const section = settingsCategory(path);
    expect(section, `${path} is reported by name`).not.toBe("other");
    expect(section, `${path} is sent by name`).toMatch(SENT_AS_IS);
  }
  expect(settingsCategory("/settings/documents")).toBe("documents");
  // A page split from one the contract names reports as that page.
  expect(settingsCategory("/settings/maintenance")).toBe("storage");
});
it("reports a file tab's extension and nothing else about it", () => {
  const file = (relativePath: string, attachmentName?: string) =>
    panelViewProperties({
      id: "file:PRIVATE",
      kind: "file",
      relativePath,
      revealLine: null,
      revealRequestId: 0,
      ...(attachmentName === undefined
        ? {}
        : { attachment: { name: attachmentName } as RightPanelFileAttachment }),
    });
  expect(file("PRIVATE/Results.v2.CSV")).toEqual({ category: "file-preview", fileType: "csv" });
  expect(file("PRIVATE\\Makefile")).toEqual({ category: "file-preview", fileType: "none" });
  expect(file("PRIVATE/.env")).toEqual({ category: "file-preview", fileType: "none" });
  expect(file("PRIVATE-attachment-id", "scan.TIFF")).toEqual({
    category: "file-preview",
    fileType: "tiff",
  });
  expect(
    panelViewProperties({
      id: "scient:file:PRIVATE",
      kind: "scient",
      module: "file",
      path: "/Users/PRIVATE/brain.nii",
      line: null,
    }),
  ).toEqual({ category: "file-preview", fileType: "nii" });
  expect(panelViewProperties({ id: "scient:sources", kind: "scient", module: "sources" })).toEqual({
    category: "sources",
  });
});
