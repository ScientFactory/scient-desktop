import { describe, expect, it } from "@effect/vitest";

import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";

const { setup } = JULIA_KERNEL_LANGUAGE;

describe("Julia kernel setup", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "names Scient's depot alone and adds the installation's from inside Julia on %s",
    (platform) => {
      if (typeof setup !== "function") return expect.unreachable("Julia sets up by running Julia");
      const { args, environment } = setup(
        "/scient/julia",
        { JULIA_DEPOT_PATH: "/people/own/depot" },
        platform,
      );
      // An empty entry would bring in the person's ~/.julia before Julia 1.11.
      expect(environment.JULIA_DEPOT_PATH).toMatch(/^[/\\]scient[/\\]julia[/\\]depot$/u);
      // Without the installation's depots Julia compiles its standard library again.
      const script = args.at(-1) ?? "";
      expect(script.indexOf("Sys.BINDIR")).toBeGreaterThan(-1);
      expect(script.indexOf('ENV["JULIA_DEPOT_PATH"]')).toBeLessThan(script.indexOf("using Pkg"));
    },
  );
});
