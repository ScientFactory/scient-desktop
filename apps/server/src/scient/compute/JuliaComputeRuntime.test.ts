import { describe, expect, it } from "@effect/vitest";

import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";

const { launch, setup } = JULIA_KERNEL_LANGUAGE;

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
    // `pkgversion` exists only from Julia 1.9.
    expect(script).not.toContain("pkgversion");
  });
});

describe("Julia kernel launch", () => {
  it("adds Scient's depot and environment after the person's, from inside Julia", () => {
    const { argv, environment } = launch({
      executable: "/bin/julia",
      privateDirectory: "/scient/julia",
      environment: { JULIA_DEPOT_PATH: "/people/own/depot" },
      platform: "darwin",
      home: "/bin",
    });
    // No path list for Julia to expand: 1.11.0 and 1.11.1 read an empty entry as the
    // installation's depots alone and dropped the person's ~/.julia.
    expect(environment).toEqual({ JULIA_PROJECT: "@." });
    const script = argv[argv.indexOf("-e") + 1] ?? "";
    expect(argv.slice(argv.indexOf("-e") + 2).map((part) => part.replaceAll("\\", "/"))).toEqual([
      "/scient/julia/depot",
      "/scient/julia/environment",
      "{connection_file}",
    ]);
    const runs = script.indexOf("import IJulia");
    for (const step of [
      "popfirst!(ARGS)",
      "push!(DEPOT_PATH, depot)",
      "push!(LOAD_PATH, environment)",
    ]) {
      expect(script.indexOf(step), step).toBeGreaterThan(-1);
      expect(script.indexOf(step), step).toBeLessThan(runs);
    }
  });

  it("runs the installation's own IJulia with nothing added", () => {
    const { argv, environment } = launch({
      executable: "/bin/julia",
      privateDirectory: null,
      environment: { JULIA_PROJECT: "/people/project" },
      platform: "win32",
      home: "/bin",
    });
    expect(argv.at(-1)).toBe("{connection_file}");
    // The IJulia an older Julia installs has no `run_kernel`.
    expect(argv.at(-2)).toMatch(/^import IJulia; .*run_kernel.*kernel\.jl/u);
    expect(environment).toEqual({});
  });
});
