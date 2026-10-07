import { describe, expect, it } from "vite-plus/test";

import { compactPathLabel } from "./compactPathLabel";

describe("compactPathLabel", () => {
  it("keeps the last two segments of an absolute path", () => {
    expect(
      compactPathLabel(
        "/Users/someone/REPOs/worktrees/sync/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
        undefined,
      ),
    ).toBe("Layers/ProviderCommandReactor.ts");
    expect(
      compactPathLabel("~/REPOs/worktrees/sync/packages/contracts/src/orchestration.ts", undefined),
    ).toBe("src/orchestration.ts");
    expect(compactPathLabel("C:\\Users\\someone\\project\\src\\app.ts", undefined)).toBe(
      "src/app.ts",
    );
  });

  it("shortens a path inside the workspace the same way", () => {
    expect(compactPathLabel("/work/project/apps/web/src/main.tsx", "/work/project")).toBe(
      "src/main.tsx",
    );
    expect(compactPathLabel("/work/project/README.md", "/work/project")).toBe("project/README.md");
  });

  it("keeps a line number with the file name", () => {
    expect(compactPathLabel("/work/project/src/deep/file.ts:42", undefined)).toBe(
      "deep/file.ts:42",
    );
  });

  it("leaves text that is not a single path unchanged", () => {
    for (const text of [
      "TODO in src",
      "Read upstream-alignment-protocol.md",
      "pnpm lint",
      "/Users/someone/a.ts\nsecond line",
      "node:internal/modules/esm/resolve:271 throw new ERR_MODULE_NOT_FOUND(",
    ]) {
      expect(compactPathLabel(text, undefined)).toBe(text);
    }
  });
});
