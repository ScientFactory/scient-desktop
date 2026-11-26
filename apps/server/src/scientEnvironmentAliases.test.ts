import { describe, expect, it } from "@effect/vitest";

import { applyScientEnvironmentAliases } from "./scientEnvironmentAliases.ts";

describe("applyScientEnvironmentAliases", () => {
  it("sets a documented setting from its SCIENT_ name, over the T3CODE_ name", () => {
    const env: NodeJS.ProcessEnv = {
      SCIENT_TERMINAL_SHELL: "/bin/zsh",
      T3CODE_TERMINAL_SHELL: "/bin/bash",
      T3CODE_HOST: "127.0.0.1",
    };

    applyScientEnvironmentAliases(env);

    expect(env.T3CODE_TERMINAL_SHELL).toBe("/bin/zsh");
    expect(env.T3CODE_HOST).toBe("127.0.0.1");
  });

  it("leaves Scient's own variables out of the T3CODE_ names", () => {
    const env: NodeJS.ProcessEnv = { SCIENT_NEXT_HOME: "/home/me/.scient-next" };

    applyScientEnvironmentAliases(env);

    expect(env).toEqual({ SCIENT_NEXT_HOME: "/home/me/.scient-next" });
  });
});
