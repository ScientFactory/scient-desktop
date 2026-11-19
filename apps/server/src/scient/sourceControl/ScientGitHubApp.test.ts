import { describe, expect, it } from "@effect/vitest";

import { SCIENT_GITHUB_APP_CLIENT_ID, withScientGitHubApp } from "./ScientGitHubApp.ts";

describe("withScientGitHubApp", () => {
  it.each([
    ["Scient's app when the operator set none", undefined, SCIENT_GITHUB_APP_CLIENT_ID],
    ["the operator's own test app", "Iv-test-app", "Iv-test-app"],
    ["no app when the operator turned it off", "", ""],
  ])("signs in with %s", (_, configured, expected) => {
    const environment: NodeJS.ProcessEnv =
      configured === undefined ? {} : { T3CODE_GITHUB_APP_CLIENT_ID: configured };
    expect(withScientGitHubApp(environment).T3CODE_GITHUB_APP_CLIENT_ID).toBe(expected);
  });

  it("keeps reading the live environment", () => {
    const environment: NodeJS.ProcessEnv = {};
    const wrapped = withScientGitHubApp(environment);
    environment.GH_TOKEN = "set-after-start";
    expect(wrapped.GH_TOKEN).toBe("set-after-start");
  });
});
