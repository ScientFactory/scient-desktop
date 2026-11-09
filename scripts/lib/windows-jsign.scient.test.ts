import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { JsignConfigurationError, signWithJsign } from "./windows-jsign.ts";

// SCIENT-FORK: Scient rejects a signing endpoint that is not a bare HTTPS host before jsign runs.
it.effect.each([
  "not a URL",
  "http://eus.codesigning.azure.net/",
  "https://user:password@eus.codesigning.azure.net/",
  "https://eus.codesigning.azure.net/path",
])("rejects the signing endpoint %s without running jsign", (endpoint) => {
  let spawned = 0;
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => {
      spawned++;
      return Effect.die("jsign must not run");
    }),
  );
  return Effect.gen(function* () {
    const error = yield* signWithJsign("/stage/Scient desktop.exe").pipe(Effect.flip);
    assert.instanceOf(error, JsignConfigurationError);
    assert.equal(spawned, 0);
  }).pipe(
    Effect.provide(
      // The fake spawner comes last, so it replaces the Node one.
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              AZURE_TRUSTED_SIGNING_ENDPOINT: endpoint,
              AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "account",
              AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
            },
          }),
        ),
        spawner,
      ),
    ),
  );
});
