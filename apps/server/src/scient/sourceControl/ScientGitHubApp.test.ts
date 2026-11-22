import { describe, expect, it } from "@effect/vitest";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SCIENT_GITHUB_APP_CLIENT_ID, withScientGitHubApp } from "./ScientGitHubApp.ts";

describe("withScientGitHubApp", () => {
  it.effect.each([
    ["Scient's app when the operator set none", undefined, SCIENT_GITHUB_APP_CLIENT_ID],
    ["the operator's own test app", "github_app_client_id=Iv-test-app", "Iv-test-app"],
    ["no app when the operator turned it off", "github_app_client_id=", ""],
  ])("signs in with %s", ([_, flags, expected]) =>
    Effect.gen(function* () {
      const resolved = withScientGitHubApp(yield* FeatureFlags.resolve(flags));
      expect(Option.getOrElse(resolved.githubAppClientId, () => "")).toBe(expected);
    }),
  );

  it.effect("keeps the other flags", () =>
    Effect.gen(function* () {
      const resolved = withScientGitHubApp(yield* FeatureFlags.resolve("tanstack_source"));
      expect(resolved.tanstackSource).toBe(true);
      expect(resolved.secretProviders).toBe(false);
    }),
  );
});
