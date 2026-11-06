import { describe, expect, it } from "@effect/vitest";

import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";

const { setup } = JULIA_KERNEL_LANGUAGE;

describe("Julia kernel setup", () => {
  // Julia reads the standard library it ships compiled only from its installation's depots; a
  // depot path naming Scient's depot alone made every first setup compile it again.
  it.each([
    { platform: "darwin", separator: ":" },
    { platform: "linux", separator: ":" },
    { platform: "win32", separator: ";" },
  ] as const)("keeps the installation's own depots after Scient's on $platform", (input) => {
    if (typeof setup !== "function") return expect.unreachable("Julia sets up by running Julia");
    const { environment } = setup(
      "/scient/julia",
      { JULIA_DEPOT_PATH: "/people/own/depot" },
      input.platform,
    );
    // The empty last entry stands for the installation's depots, never the person's.
    expect(environment.JULIA_DEPOT_PATH?.split(input.separator)).toEqual([
      expect.stringMatching(/^[/\\]scient[/\\]julia[/\\]depot$/u),
      "",
    ]);
  });
});
