import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http";

import { readCursorUsageLimits } from "./cursorUsageLimits.ts";

// Reading the Cursor CLI's Keychain login makes macOS ask for a password, and the
// provider check runs at launch. With default settings it must never be read.
it.effect("does not read the macOS Keychain under default settings", () =>
  Effect.gen(function* () {
    let keychainReads = 0;
    const limits = yield* readCursorUsageLimits(
      { apiEndpoint: "" },
      {},
      DEFAULT_SERVER_SETTINGS.cursorKeychainUsageEnabled,
      async () => {
        keychainReads += 1;
        return "keychain-token";
      },
    ).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.die("must not read a credential file"),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("must not request usage without a login")),
      ),
    );
    expect(keychainReads).toBe(0);
    expect(limits.unavailable?.message).toBe(
      "Enable Cursor account usage in Scient to read its Keychain login.",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
