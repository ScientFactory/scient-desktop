import { describe, expect, it } from "@effect/vitest";

import { ompProcessEnvironment as buildEnvironment } from "./OmpEnvironment.ts";

/** POSIX unless a test says otherwise. */
const ompProcessEnvironment = (
  input: Omit<Parameters<typeof buildEnvironment>[0], "platform"> & {
    readonly platform?: NodeJS.Platform;
  },
) => buildEnvironment({ platform: "darwin", ...input });

const LOGIN = {
  HOME: "/home/u",
  PATH: "/usr/bin",
  // Model providers OMP reads itself, including cloud credential chains.
  ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth",
  AWS_PROFILE: "bedrock",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "aws-key",
  GOOGLE_CLOUD_PROJECT: "vertex-project",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/u/gcp.json",
  // Tools a full-access agent runs.
  GH_TOKEN: "gh-token",
  GITHUB_TOKEN: "github-token",
  GIT_AUTHOR_NAME: "U",
  SSH_AUTH_SOCK: "/tmp/ssh.sock",
  JAVA_HOME: "/opt/java",
  CARGO_HOME: "/home/u/.cargo",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  DISPLAY: ":0",
  HTTPS_PROXY: "http://proxy.internal:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
  // OMP's own coordinates.
  PI_CODING_AGENT_DIR: "/home/u/.omp-custom/agent",
  OMP_WORKTREE_DIR: "/home/u/worktrees",
  PI_CONFIG_DIR: ".omp",
  // Scient and T3 server internals.
  T3CODE_PORT: "3773",
  T3CODE_DEV_AUTH_TOKEN: "dev-token",
  T3CODE_HOME: "/home/u/.scient-next",
  T3_MCP_BEARER_TOKEN: "mcp-token",
  SCIENT_SERVER_TOKEN: "server-token",
  SCIENT_NEXT_HOME: "/home/u/.scient-next",
  SCIENT_OMP_MODELS_TOKEN: "stale-bridge-token",
  SCIENT_OMP_MODEL_KEY_1: "stale-bridge-key",
  VITE_DEV_SERVER_URL: "http://localhost:5733",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_RENDERER_PORT: "5733",
  PORT: "5733",
  // Scient sets the session directory per process.
  PI_CODING_AGENT_SESSION_DIR: "/somewhere/else",
};

describe("Oh My Pi process environment", () => {
  it("inherits the login environment, including provider, cloud and toolchain variables", () => {
    const environment = ompProcessEnvironment({ baseEnv: LOGIN });
    for (const name of [
      "HOME",
      "PATH",
      "ANTHROPIC_OAUTH_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_AUTHOR_NAME",
      "SSH_AUTH_SOCK",
      "JAVA_HOME",
      "CARGO_HOME",
      "DOCKER_HOST",
      "DISPLAY",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "PI_CODING_AGENT_DIR",
      "OMP_WORKTREE_DIR",
      "PI_CONFIG_DIR",
    ] as const) {
      expect(environment[name], name).toBe(LOGIN[name]);
    }
  });

  it("excludes Scient and T3 server internals and the Scient-owned session directory", () => {
    const environment = ompProcessEnvironment({ baseEnv: LOGIN });
    for (const name of [
      "T3CODE_PORT",
      "T3CODE_DEV_AUTH_TOKEN",
      "T3CODE_HOME",
      "T3_MCP_BEARER_TOKEN",
      "SCIENT_SERVER_TOKEN",
      "SCIENT_NEXT_HOME",
      "SCIENT_OMP_MODELS_TOKEN",
      "SCIENT_OMP_MODEL_KEY_1",
      "VITE_DEV_SERVER_URL",
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_RENDERER_PORT",
      "PORT",
      "PI_CODING_AGENT_SESSION_DIR",
    ]) {
      expect(environment, name).not.toHaveProperty(name);
    }
    // Windows names are case-insensitive.
    expect(
      ompProcessEnvironment({ baseEnv: { Scient_Server_Token: "x" }, platform: "win32" }),
    ).toEqual({ NO_PROXY: "127.0.0.1,localhost,::1" });
  });

  it("names internals by prefix and exact name, and nothing that merely resembles them", () => {
    const environment = ompProcessEnvironment({
      baseEnv: {
        T3CODE_BOOTSTRAP_FD: "3",
        T3_PAIRING_KEY: "pairing",
        SCIENT_ANALYTICS_ENABLED: "1",
        scient_admin_api_key: "admin",
        ELECTRON_ENABLE_LOGGING: "1",
        T3X: "kept",
        SCIENTIFIC_DATA: "/data",
        PORTAGE_TMPDIR: "/tmp",
        ANTHROPIC_API_KEY: "anthropic",
      },
    });
    expect(Object.keys(environment).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ELECTRON_ENABLE_LOGGING",
      "NO_PROXY",
      "PORTAGE_TMPDIR",
      "SCIENTIFIC_DATA",
      "T3X",
      "no_proxy",
    ]);
  });

  it("applies the instance environment as configured, filtering only what was inherited", () => {
    const environment = ompProcessEnvironment({
      baseEnv: LOGIN,
      instanceEnvironment: [
        { name: "AWS_PROFILE", value: "work", sensitive: false },
        { name: "OMP_EXPLICIT_SETTING", value: "kept", sensitive: false },
        // The user's own variables, even with names like Scient's internals.
        { name: "SCIENT_DATASET", value: "configured", sensitive: false },
        { name: "T3CODE_PORT", value: "4000", sensitive: false },
        // Scient still owns the session directory.
        { name: "PI_CODING_AGENT_SESSION_DIR", value: "/configured", sensitive: false },
      ],
    });
    expect(environment.AWS_PROFILE).toBe("work");
    expect(environment.OMP_EXPLICIT_SETTING).toBe("kept");
    expect(environment.SCIENT_DATASET).toBe("configured");
    expect(environment.T3CODE_PORT).toBe("4000");
    // Inherited internals stay out.
    expect(environment).not.toHaveProperty("SCIENT_SERVER_TOKEN");
    expect(environment).not.toHaveProperty("T3CODE_DEV_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("PI_CODING_AGENT_SESSION_DIR");
  });

  it("lets an instance home replace the inherited home and profile", () => {
    const environment = ompProcessEnvironment({
      baseEnv: { ...LOGIN, OMP_PROFILE: "inherited", PI_PROFILE: "legacy" },
      homePath: "/srv/omp-home",
    });
    expect(environment.PI_CODING_AGENT_DIR).toBe("/srv/omp-home");
    // A named profile would otherwise win over the agent directory.
    expect(environment).not.toHaveProperty("OMP_PROFILE");
    expect(environment).not.toHaveProperty("PI_PROFILE");
  });

  it("lets an instance profile replace the inherited profile and home", () => {
    const environment = ompProcessEnvironment({
      baseEnv: { ...LOGIN, PI_PROFILE: "legacy" },
      profile: "work",
    });
    expect(environment.OMP_PROFILE).toBe("work");
    expect(environment).not.toHaveProperty("PI_PROFILE");
    expect(environment).not.toHaveProperty("PI_CODING_AGENT_DIR");
  });

  it("drops a legacy profile that an explicitly empty OMP_PROFILE already overrides", () => {
    const environment = ompProcessEnvironment({
      baseEnv: { HOME: "/home/u", OMP_PROFILE: "", PI_PROFILE: "legacy" },
    });
    expect(environment.OMP_PROFILE).toBe("");
    expect(environment).not.toHaveProperty("PI_PROFILE");
  });

  it("keeps Scient's loopback endpoints out of an inherited proxy", () => {
    const environment = ompProcessEnvironment({
      baseEnv: { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "corp.internal, localhost" },
      platform: "darwin",
    });
    expect(environment.HTTPS_PROXY).toBe("http://proxy.corp:3128");
    expect(environment.NO_PROXY).toBe("corp.internal,localhost,127.0.0.1,::1");
    // Bun reads the lowercase spelling first; it must carry the user's list too.
    expect(environment.no_proxy).toBe("corp.internal,localhost,127.0.0.1,::1");
    // Windows has one case-insensitive variable; the existing spelling is kept.
    expect(
      ompProcessEnvironment({ baseEnv: { No_Proxy: "corp.internal" }, platform: "win32" }),
    ).toEqual({ No_Proxy: "corp.internal,127.0.0.1,localhost,::1" });
  });

  it.each([
    ["only NO_PROXY", { NO_PROXY: "corp.internal" }],
    ["only no_proxy", { no_proxy: "corp.internal" }],
  ])("keeps the user's exclusions in both spellings when they set %s", (_label, baseEnv) => {
    const environment = ompProcessEnvironment({ baseEnv });
    expect(environment.NO_PROXY).toBe("corp.internal,127.0.0.1,localhost,::1");
    expect(environment.no_proxy).toBe("corp.internal,127.0.0.1,localhost,::1");
  });

  it("unions the two spellings when they differ", () => {
    const environment = ompProcessEnvironment({
      baseEnv: { NO_PROXY: "a.internal,localhost", no_proxy: "b.internal, a.internal" },
    });
    expect(environment.NO_PROXY).toBe("a.internal,localhost,b.internal,127.0.0.1,::1");
    expect(environment.no_proxy).toBe(environment.NO_PROXY);
  });

  it("merges every Windows spelling into one variable", () => {
    const environment = ompProcessEnvironment({
      baseEnv: { NO_PROXY: "a.internal" },
      instanceEnvironment: [{ name: "no_proxy", value: "b.internal", sensitive: false }],
      platform: "win32",
    });
    expect(environment).toEqual({ NO_PROXY: "a.internal,b.internal,127.0.0.1,localhost,::1" });
  });
});
