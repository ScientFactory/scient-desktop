// @effect-diagnostics nodeBuiltinImport:off -- Reads platform metadata only.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { overleafFilesAvailability } from "./overleafFileAvailability.ts";
describe("Overleaf macOS file availability", () => {
  it.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
    "reads macOS flags for many files in one run, a vanished one included",
    async () => {
      const found = await overleafFilesAvailability([
        import.meta.filename,
        `${import.meta.filename}.gone`,
      ]);
      expect([...found.values()]).toEqual(["available", "available"]);
    },
  );
});
