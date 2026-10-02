import { describe, expect, it } from "@effect/vitest";

import {
  agentProcessEnvironment as buildEnvironment,
  withoutInheritedEnvironment,
} from "./agentProcessEnvironment.ts";

/** POSIX unless a test says otherwise. */
const agentProcessEnvironment = (
  input: Omit<Parameters<typeof buildEnvironment>[0], "platform"> & {
    readonly platform?: NodeJS.Platform;
  },
) => buildEnvironment({ platform: "darwin", ...input });

const LOGIN = {
  HOME: "/home/u",
  PATH: "/usr/bin",
  // Agent and model credentials the CLI reads itself.
  FACTORY_API_KEY: "fk-user",
  ANTHROPIC_API_KEY: "anthropic",
  AWS_PROFILE: "bedrock",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/u/gcp.json",
  // Tools a full-access agent runs.
  GH_TOKEN: "gh-token",
  GIT_AUTHOR_NAME: "U",
  SSH_AUTH_SOCK: "/tmp/ssh.sock",
  JAVA_HOME: "/opt/java",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  HTTPS_PROXY: "http://proxy.internal:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
  FACTORY_HOME_OVERRIDE: "/home/u/.factory-work",
  // Scient and T3 server internals.
  T3CODE_PORT: "3773",
  T3CODE_OTLP_HEADERS: "authorization=Bearer otlp",
  T3CODE_HOME: "/home/u/.scient-next",
  T3_MCP_BEARER_TOKEN: "mcp-token",
  SCIENT_SERVER_TOKEN: "server-token",
  SCIENT_NEXT_HOME: "/home/u/.scient-next",
  SCIENT_DROID_KEY_0123: "stale-key",
  VITE_DEV_SERVER_URL: "http://localhost:5733",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_RENDERER_PORT: "5733",
  PORT: "5733",
};

describe("agent process environment", () => {
  it("inherits the login environment, including agent, cloud and toolchain variables", () => {
    const environment = agentProcessEnvironment({ baseEnv: LOGIN });
    for (const name of [
      "HOME",
      "PATH",
      "FACTORY_API_KEY",
      "ANTHROPIC_API_KEY",
      "AWS_PROFILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GH_TOKEN",
      "GIT_AUTHOR_NAME",
      "SSH_AUTH_SOCK",
      "JAVA_HOME",
      "DOCKER_HOST",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "FACTORY_HOME_OVERRIDE",
    ] as const) {
      expect(environment[name], name).toBe(LOGIN[name]);
    }
  });

  it("excludes Scient and T3 server internals", () => {
    const environment = agentProcessEnvironment({ baseEnv: LOGIN });
    for (const name of [
      "T3CODE_PORT",
      "T3CODE_OTLP_HEADERS",
      "T3CODE_HOME",
      "T3_MCP_BEARER_TOKEN",
      "SCIENT_SERVER_TOKEN",
      "SCIENT_NEXT_HOME",
      "SCIENT_DROID_KEY_0123",
      "VITE_DEV_SERVER_URL",
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_RENDERER_PORT",
      "PORT",
    ]) {
      expect(environment, name).not.toHaveProperty(name);
    }
    // Windows names are case-insensitive.
    expect(
      agentProcessEnvironment({ baseEnv: { Scient_Server_Token: "x" }, platform: "win32" }),
    ).toEqual({ NO_PROXY: "127.0.0.1,localhost,::1" });
  });

  it("names internals by prefix and exact name, and nothing that merely resembles them", () => {
    const environment = agentProcessEnvironment({
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
    expect(Object.keys(environment).toSorted()).toEqual([
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
    const environment = agentProcessEnvironment({
      baseEnv: LOGIN,
      instanceEnvironment: [
        { name: "AWS_PROFILE", value: "work", sensitive: false },
        { name: "FACTORY_API_KEY", value: "fk-instance", sensitive: true },
        // The user's own variables, even with names like Scient's internals.
        { name: "SCIENT_DATASET", value: "configured", sensitive: false },
        { name: "T3CODE_PORT", value: "4000", sensitive: false },
      ],
    });
    expect(environment.AWS_PROFILE).toBe("work");
    expect(environment.FACTORY_API_KEY).toBe("fk-instance");
    expect(environment.SCIENT_DATASET).toBe("configured");
    expect(environment.T3CODE_PORT).toBe("4000");
    expect(environment).not.toHaveProperty("SCIENT_SERVER_TOKEN");
    expect(environment).not.toHaveProperty("T3CODE_OTLP_HEADERS");
  });

  it("keeps Scient's loopback endpoints out of an inherited proxy", () => {
    const environment = agentProcessEnvironment({
      baseEnv: { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "corp.internal, localhost" },
    });
    expect(environment.HTTPS_PROXY).toBe("http://proxy.corp:3128");
    expect(environment.NO_PROXY).toBe("corp.internal,localhost,127.0.0.1,::1");
    expect(environment.no_proxy).toBe("corp.internal,localhost,127.0.0.1,::1");
    // Windows has one case-insensitive variable; the existing spelling is kept.
    expect(
      agentProcessEnvironment({ baseEnv: { No_Proxy: "corp.internal" }, platform: "win32" }),
    ).toEqual({ No_Proxy: "corp.internal,127.0.0.1,localhost,::1" });
  });

  it("merges both proxy exclusion spellings instead of letting one win", () => {
    const environment = agentProcessEnvironment({
      baseEnv: { NO_PROXY: "a.internal", no_proxy: "b.internal,a.internal" },
      instanceEnvironment: [{ name: "no_proxy", value: "c.internal", sensitive: false }],
    });
    expect(environment.NO_PROXY).toBe("a.internal,c.internal,127.0.0.1,localhost,::1");
    expect(environment.no_proxy).toBe(environment.NO_PROXY);
  });

  it("masks inherited names the rule removed for spawners that merge the parent environment", () => {
    const inherited = { PATH: "/usr/bin", SCIENT_SERVER_TOKEN: "server", Path: "x" };
    const env = agentProcessEnvironment({ baseEnv: inherited });
    const masked = withoutInheritedEnvironment(env, "darwin", inherited);
    expect(masked).toHaveProperty("SCIENT_SERVER_TOKEN", undefined);
    expect(masked.PATH).toBe("/usr/bin");
    // What a merging spawner sees: the parent environment, then this one.
    const merged = Object.fromEntries(
      Object.entries({ ...inherited, ...masked }).filter(([, value]) => value !== undefined),
    );
    expect(merged).toEqual(env);
    // Windows: one variable per case-insensitive name, never a masked duplicate.
    const windows = withoutInheritedEnvironment({ Path: "C:\\bin" }, "win32", {
      PATH: "C:\\bin",
      T3CODE_PORT: "1",
    });
    expect(windows).toEqual({ Path: "C:\\bin", T3CODE_PORT: undefined });
  });
});
