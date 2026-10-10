import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";

import { readCursorUsageLimits } from "@t3tools/provider-cursor/server";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";

// Reading the Cursor CLI's Keychain login makes macOS ask for a password, and the
// provider check runs at launch. With default settings it must never be read.
it.effect("does not read the macOS Keychain under default settings", () =>
  Effect.gen(function* () {
    let keychainReads = 0;
    const limits = yield* readCursorUsageLimits(
      { apiEndpoint: "" },
      {},
      DEFAULT_SERVER_SETTINGS.cursorKeychainUsageEnabled,
    ).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(CursorKeychain.CursorKeychain, {
        accessToken: Effect.sync(() => {
          keychainReads += 1;
          return "keychain-token";
        }),
      }),
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
