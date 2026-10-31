// @effect-diagnostics nodeBuiltinImport:off -- Metadata probe against this source file.
import { describe, expect, it } from "@effect/vitest";
import { overleafFilesAvailability, windowsFlagBatches } from "./overleafFileAvailability.ts";

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

  it("batches Windows paths to fit one helper question and one command line", () => {
    const long = Array.from({ length: 200 }, (_, index) => `C:\\${"a".repeat(200)}${index}`);
    const wide = Array.from(
      { length: 90 },
      (_, index) => `C:\\${String.fromCharCode(0x4e00 + index).repeat(250)}`,
    );
    const helper = `C:\\${"h".repeat(250)}\\scient-file-publication.exe`;
    for (const paths of [long, wide]) {
      const batches = windowsFlagBatches(paths);
      expect(batches.flat()).toEqual(paths);
      for (const batch of batches) {
        const frame = ["--windows-flags=1", ...batch].map((argument) => `${argument}\0`);
        expect(Buffer.byteLength(frame.join(""))).toBeLessThanOrEqual(65_536);
        const command = [helper, "--windows-flags=1", ...batch].map((argument) => `"${argument}"`);
        expect(command.join(" ").length).toBeLessThan(32_767);
      }
    }
  });
});
