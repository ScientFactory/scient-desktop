import { describe, expect, it } from "@effect/vitest";

import { applyScientEnvironmentAliases } from "./scientEnvironmentAliases.ts";

describe("applyScientEnvironmentAliases", () => {
  it("sets a documented setting from its SCIENT_ name, over the T3CODE_ name", () => {
    const env: NodeJS.ProcessEnv = {
      SCIENT_TERMINAL_SHELL: "/bin/zsh",
      T3CODE_TERMINAL_SHELL: "/bin/bash",
      T3CODE_HOST_ID: "laptop",
    };

    applyScientEnvironmentAliases(env);

    expect(env.T3CODE_TERMINAL_SHELL).toBe("/bin/zsh");
    expect(env.T3CODE_HOST_ID).toBe("laptop");
  });

  it("leaves Scient's own variables and the service.env settings alone", () => {
    const env: NodeJS.ProcessEnv = {
      SCIENT_NEXT_HOME: "/home/me/.scient-next",
      SCIENT_LAN: "true",
      T3CODE_LAN: "false",
    };

    applyScientEnvironmentAliases(env);

    expect(env).toEqual({
      SCIENT_NEXT_HOME: "/home/me/.scient-next",
      SCIENT_LAN: "true",
      T3CODE_LAN: "false",
    });
  });
});
