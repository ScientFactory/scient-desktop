import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { verifyPluginSignIn } from "./pluginAuthManifest.ts";
import type { PluginSignInCandidate } from "./pluginSignIn.ts";

const ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CLIENT = "synthetic-client.example";

const candidate = (overrides: {
  readonly plugin?: string;
  readonly program?: string;
  readonly clientId?: string;
  readonly endpoint?: string;
}): PluginSignInCandidate => ({
  sessionId: "session-1",
  toolCallId: "call-1",
  generation: 1,
  program: overrides.program ?? "gmail",
  challenge: {
    plugin: overrides.plugin ?? "gmail",
    authorizationUrl: `${ENDPOINT}?client_id=${CLIENT}`,
    endpoint: overrides.endpoint ?? ENDPOINT,
    clientId: overrides.clientId ?? CLIENT,
    secrets: [],
  },
});

const installGmail = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plugins = yield* fileSystem.makeTempDirectoryScoped();
  const folder = path.join(plugins, "gmail");
  yield* fileSystem.makeDirectory(folder);
  yield* fileSystem.writeFileString(
    path.join(folder, "plugin.json"),
    JSON.stringify({ name: "gmail", displayName: "Gmail" }),
  );
  yield* fileSystem.writeFileString(
    path.join(folder, "auth.json"),
    JSON.stringify({
      providers: {
        google: {
          type: "oauth2",
          clis: ["gmail"],
          oauth2: { authorizeUrl: ENDPOINT, clientId: CLIENT, clientSecret: "synthetic" },
        },
      },
    }),
  );
  return plugins;
});

it.effect("admits only what the installed plugin's manifest declares", () =>
  Effect.gen(function* () {
    const pluginsDirectory = yield* installGmail;
    const verify = (overrides: Parameters<typeof candidate>[0]) =>
      verifyPluginSignIn({ pluginsDirectory, candidate: candidate(overrides) });
    assert.deepEqual(yield* verify({}), { displayName: "Gmail", programs: ["gmail"] });
    // regression: a page for another OAuth client used to earn a trusted notice.
    assert.isUndefined(yield* verify({ clientId: "attacker-client.example" }));
    assert.isUndefined(yield* verify({ endpoint: "https://evil.example/o/oauth2/v2/auth" }));
    assert.isUndefined(yield* verify({ program: "cat" }));
    assert.isUndefined(yield* verify({ plugin: "gdrive" }));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
