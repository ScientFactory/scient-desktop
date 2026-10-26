// @effect-diagnostics nodeBuiltinImport:off -- Metadata probe against this source file.
import { describe, expect, it } from "@effect/vitest";
import { overleafFilesAvailability } from "./overleafFileAvailability.ts";

const one = async (platform: string, flags?: number) =>
  (
    await overleafFilesAvailability(
      ["unused"],
      platform,
      flags === undefined ? undefined : async () => [flags],
    )
  ).get("unused");

describe("Overleaf online-only files", () => {
  it("refuses each Windows recall attribute without opening file contents", async () => {
    for (const flag of [0x1000, 0x40000, 0x400000])
      expect(await one("win32", flag)).toBe("online-only-file");
    expect(await one("win32", 0x20)).toBe("available");
    expect(await one("win32")).toBe("helper-unavailable");
    expect(await one("win32", -1)).toBe("helper-unavailable");
    expect(await one("linux")).toBe("available");
    expect(await one("darwin", 0x40000000)).toBe("online-only-file");
    expect(await one("darwin", 0x20)).toBe("available");
  });
});
