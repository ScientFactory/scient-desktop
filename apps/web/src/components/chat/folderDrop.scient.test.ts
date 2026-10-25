import { describe, expect, it } from "vite-plus/test";

import { resolveDroppedFolderPath } from "./folderDrop";

describe("resolveDroppedFolderPath", () => {
  // ChatComposer refuses the drop with a toast on null instead of inserting a bogus path.
  // regression: d1a6448971 fix(web): dropped folders become path chips on the local environment and are refused on remote ones (#12001)
  it("returns null when the desktop bridge cannot resolve the dropped item", () => {
    const folder = new File([], "contracts");
    expect(resolveDroppedFolderPath(folder, () => null)).toBeNull();
  });
});
