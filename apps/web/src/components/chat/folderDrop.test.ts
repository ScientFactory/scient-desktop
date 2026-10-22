import { describe, expect, it } from "@effect/vitest";

import { resolveDroppedFolderPath } from "./folderDrop";

describe("resolveDroppedFolderPath", () => {
  it("returns null when the desktop bridge cannot resolve the dropped item", () => {
    const folder = new File([], "contracts");
    expect(resolveDroppedFolderPath(folder, () => null)).toBeNull();
  });
});
