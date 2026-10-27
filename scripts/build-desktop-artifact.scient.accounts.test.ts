import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createBuildConfig } from "./build-desktop-artifact.ts";

it.effect("keeps packaged profile cookies encrypted on every platform", () =>
  Effect.gen(function* () {
    for (const platform of ["mac", "linux", "win"] as const) {
      const config = yield* createBuildConfig(
        platform,
        platform === "mac" ? "dmg" : platform === "linux" ? "AppImage" : "nsis",
        "0.0.0-preview.accounts",
        false,
        false,
        undefined,
        undefined,
      );
      expect(config.electronFuses).toEqual({ enableCookieEncryption: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
