import { describe, expect, it } from "@effect/vitest";

import { ompTarget } from "../omp/OmpTarget.ts";
import { scientAgentProcessEnvironment, scientAgentTarget } from "./ScientAgentTarget.ts";

const runtimeInfo = (overrides: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    product: "scient-agent",
    version: "0.1.0",
    upstream: { name: "oh-my-pi", version: "18.4.8", commit: "717f97f4d22b" },
    rpcProtocolVersions: [1, 2],
    buildId: "fdf1439cc04f",
    ...overrides,
  })}\n`;

describe("scientAgentTarget.identify", () => {
  it("reads the product version and the Oh My Pi release it runs", () => {
    expect(scientAgentTarget.identify(runtimeInfo())).toEqual({
      version: "0.1.0",
      runtimeVersion: "18.4.8",
    });
  });

  it("refuses another product, whatever versions it reports", () => {
    expect(scientAgentTarget.identify(runtimeInfo({ product: "omp" }))).toBeUndefined();
  });

  it("refuses what an Oh My Pi executable prints", () => {
    expect(scientAgentTarget.identify("omp/18.4.8\n")).toBeUndefined();
    expect(scientAgentTarget.identify("")).toBeUndefined();
    expect(scientAgentTarget.identify("{not json")).toBeUndefined();
  });

  it("refuses a Scient Agent release outside the supported range", () => {
    expect(scientAgentTarget.identify(runtimeInfo({ version: "1.0.0" }))).toBeUndefined();
    expect(scientAgentTarget.identify(runtimeInfo({ version: "0.0.9" }))).toBeUndefined();
    expect(scientAgentTarget.identify(runtimeInfo({ version: "latest" }))).toBeUndefined();
  });

  it("refuses a version that is not well formed", () => {
    for (const version of [
      "0.1.0-..",
      "0.1.0-",
      "0.1.0--nightly",
      "0.01.0",
      "0.1",
      "v0.1.0",
      "0.1.0 ",
    ]) {
      expect(scientAgentTarget.identify(runtimeInfo({ version }))).toBeUndefined();
    }
    expect(scientAgentTarget.identify(runtimeInfo({ version: "0.2.0-rc.1" }))).toEqual({
      version: "0.2.0-rc.1",
      runtimeVersion: "18.4.8",
    });
    // A prerelease of the minimum is older than the minimum.
    expect(scientAgentTarget.identify(runtimeInfo({ version: "0.1.0-rc.1" }))).toBeUndefined();
  });

  it("refuses a build on an Oh My Pi release the server is not qualified against", () => {
    const onUpstream = (version: string) =>
      scientAgentTarget.identify(runtimeInfo({ upstream: { name: "oh-my-pi", version } }));
    expect(onUpstream("19.0.0")).toBeUndefined();
    expect(onUpstream("18.2.7")).toBeUndefined();
    expect(onUpstream("18.2.8")).toEqual({ version: "0.1.0", runtimeVersion: "18.2.8" });
  });

  it("refuses upstream metadata that is not an Oh My Pi release", () => {
    const withUpstream = (upstream: { name: string; version: string }) =>
      scientAgentTarget.identify(runtimeInfo({ upstream }));
    expect(withUpstream({ name: "oh-my-pi", version: "18.zzz" })).toBeUndefined();
    expect(withUpstream({ name: "oh-my-pi", version: "18" })).toBeUndefined();
    expect(withUpstream({ name: "oh-my-pi", version: "18.4.8-.." })).toBeUndefined();
    expect(withUpstream({ name: "oh-my-pi", version: "18.2.8--nightly" })).toBeUndefined();
    expect(withUpstream({ name: "oh-my-pi", version: "18.04.8" })).toBeUndefined();
    expect(withUpstream({ name: "something-else", version: "18.4.8" })).toBeUndefined();
  });

  it("refuses a build that does not offer RPC protocol v2", () => {
    expect(scientAgentTarget.identify(runtimeInfo({ rpcProtocolVersions: [1] }))).toBeUndefined();
  });
});

describe("the two targets", () => {
  it("share no name, folder or variable", () => {
    expect(scientAgentTarget.driverKind).not.toBe(ompTarget.driverKind);
    expect(scientAgentTarget.name).not.toBe(ompTarget.name);
    expect(scientAgentTarget.stateNamespace).not.toBe(ompTarget.stateNamespace);
    const ompNames = new Set(Object.values(ompTarget.environment));
    for (const name of Object.values(scientAgentTarget.environment)) {
      expect(ompNames.has(name)).toBe(false);
    }
  });

  it("each refuse the other's executable", () => {
    expect(ompTarget.identify(runtimeInfo())).toBeUndefined();
    expect(scientAgentTarget.identify("omp/18.4.8\n")).toBeUndefined();
  });
});

describe("scientAgentProcessEnvironment", () => {
  const environment = (
    baseEnv: NodeJS.ProcessEnv,
    instanceEnvironment: ReadonlyArray<{ name: string; value: string }> = [],
  ) =>
    scientAgentProcessEnvironment({
      baseEnv,
      instanceEnvironment: instanceEnvironment.map((variable) => ({
        ...variable,
        sensitive: false,
      })),
      root: "/state/scient-agent/instances/scient",
      platform: "darwin",
    });

  it("assigns the config root and keeps the user's own environment", () => {
    const env = environment({ HOME: "/Users/someone", PATH: "/usr/bin", OPENAI_API_KEY: "sk-x" });
    expect(env.SCIENT_AGENT_ROOT).toBe("/state/scient-agent/instances/scient");
    expect(env.HOME).toBe("/Users/someone");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENAI_API_KEY).toBe("sk-x");
  });

  it("lets nothing else choose where Scient Agent keeps its state", () => {
    const env = environment({ HOME: "/Users/someone" }, [
      { name: "SCIENT_AGENT_ROOT", value: "/elsewhere" },
      { name: "SCIENT_AGENT_CONFIG_DIR", value: ".elsewhere" },
      { name: "SCIENT_AGENT_DIR", value: "/elsewhere/agent" },
      { name: "SCIENT_AGENT_PROFILE", value: "work" },
      { name: "SCIENT_AGENT_PROFILE_FALLBACK", value: "work" },
      { name: "SCIENT_AGENT_SESSION_DIR", value: "/elsewhere/sessions" },
    ]);
    expect(env.SCIENT_AGENT_ROOT).toBe("/state/scient-agent/instances/scient");
    expect(Object.keys(env).filter((name) => name.startsWith("SCIENT_AGENT_"))).toEqual([
      "SCIENT_AGENT_ROOT",
    ]);
  });

  it("passes Oh My Pi's own variables through for a stock omp the agent may start", () => {
    const env = environment({
      HOME: "/Users/someone",
      OMP_PROFILE: "work",
      PI_CODING_AGENT_DIR: "/Users/someone/.omp/agent",
    });
    expect(env.OMP_PROFILE).toBe("work");
    expect(env.PI_CODING_AGENT_DIR).toBe("/Users/someone/.omp/agent");
  });
});
