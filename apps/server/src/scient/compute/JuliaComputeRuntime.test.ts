import { describe, expect, it } from "@effect/vitest";

import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";

const { setup } = JULIA_KERNEL_LANGUAGE;

describe("Julia kernel setup", () => {
  it("names Scient's depot alone and adds the installation's from inside Julia", () => {
    if (typeof setup !== "function") return expect.unreachable("Julia sets up by running Julia");
    const { args, environment } = setup(
      "/scient/julia",
      { JULIA_DEPOT_PATH: "/people/own/depot" },
      "darwin",
    );
    // An empty entry would bring in the person's ~/.julia before Julia 1.11.
    expect(environment.JULIA_DEPOT_PATH).toMatch(/^[/\\]scient[/\\]julia[/\\]depot$/u);
    // Without the installation's depots Julia compiles its standard library again, and the
    // processes Pkg starts must see the same list.
    const script = args.at(-1) ?? "";
    const loadsPkg = script.indexOf("using Pkg");
    for (const step of ["Sys.BINDIR", "push!(DEPOT_PATH", 'ENV["JULIA_DEPOT_PATH"]']) {
      expect(script.indexOf(step), step).toBeGreaterThan(-1);
      expect(script.indexOf(step), step).toBeLessThan(loadsPkg);
    }
  });
});
