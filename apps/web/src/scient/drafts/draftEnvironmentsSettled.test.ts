import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { describe, expect, it } from "vite-plus/test";

import { draftEnvironmentsSettled } from "./draftEnvironmentsSettled";

const catalog = (isReady: boolean, size: number) =>
  ({
    isReady,
    entries: new Map(Array.from({ length: size }, (_, i) => [`e${i}`, {}])),
  }) as unknown as EnvironmentCatalogState;

describe("draftEnvironmentsSettled", () => {
  it("settles once every reachable environment is live", () => {
    expect(
      draftEnvironmentsSettled({
        catalog: catalog(true, 1),
        reachableShellsLive: true,
        expectsPrimary: true,
      }),
    ).toBe(true);
  });

  it("settles an empty ready catalog when no primary environment is coming", () => {
    // Hosted, or the local environment disabled, after the last pairing was removed.
    expect(
      draftEnvironmentsSettled({
        catalog: catalog(true, 0),
        reachableShellsLive: false,
        expectsPrimary: false,
      }),
    ).toBe(true);
  });

  it("keeps waiting while the primary environment is being discovered or the catalog loads", () => {
    for (const input of [
      { catalog: catalog(true, 0), reachableShellsLive: false, expectsPrimary: true },
      { catalog: catalog(false, 0), reachableShellsLive: false, expectsPrimary: false },
      { catalog: catalog(true, 1), reachableShellsLive: false, expectsPrimary: false },
    ]) {
      expect(draftEnvironmentsSettled(input)).toBe(false);
    }
  });
});
