import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildBuiltInSkillReleases, renderGeneratedCatalog } from "../scripts/generate-catalog.ts";

describe("generated built-in skill catalog", () => {
  it("matches the immutable source releases", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const expected = await renderGeneratedCatalog(await buildBuiltInSkillReleases());
    const actual = await readFile(path.join(packageRoot, "src", "generated.ts"), "utf8");
    expect(actual).toBe(expected);
  });
});
