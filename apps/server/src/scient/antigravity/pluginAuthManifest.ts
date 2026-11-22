/**
 * Whether an installed Antigravity plugin vouches for a sign-in challenge: its folder names the
 * card's plugin, and its `auth.json` declares the CLI that printed the challenge together with
 * the page's endpoint and OAuth client. Only those fields are decoded; secrets stay unread.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { PluginSignInCandidate } from "./pluginSignIn.ts";

const MAX_MANIFEST_BYTES = 64 * 1024;

const PluginManifest = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, displayName: Schema.optional(Schema.String) }),
);
const AuthManifest = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Record(
      Schema.String,
      Schema.Struct({
        clis: Schema.optional(Schema.Array(Schema.String)),
        oauth2: Schema.optional(
          Schema.Struct({ authorizeUrl: Schema.String, clientId: Schema.String }),
        ),
      }),
    ),
  }),
);
const decodePluginManifest = Schema.decodeUnknownOption(PluginManifest);
const decodeAuthManifest = Schema.decodeUnknownOption(AuthManifest);

const endpointOf = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
};

const readBounded = Effect.fnUntraced(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(file);
  if (info.type !== "File" || Number(info.size) > MAX_MANIFEST_BYTES) return undefined;
  return yield* fileSystem.readFileString(file);
});

export interface VerifiedPluginSignIn {
  readonly displayName: string | undefined;
  /** Every CLI the plugin's sign-in covers; a later successful run of one confirms it. */
  readonly programs: ReadonlyArray<string>;
}

/** Undefined unless the installed plugin declares exactly what the candidate printed. */
export const verifyPluginSignIn = Effect.fn("AntigravityPluginSignIn.verify")(
  function* (input: {
    readonly pluginsDirectory: string;
    readonly candidate: PluginSignInCandidate;
  }) {
    const path = yield* Path.Path;
    const { challenge, program } = input.candidate;
    const folder = path.join(input.pluginsDirectory, challenge.plugin);
    const plugin = Option.getOrUndefined(
      decodePluginManifest(yield* readBounded(path.join(folder, "plugin.json"))),
    );
    if (plugin?.name !== challenge.plugin) return undefined;
    const auth = Option.getOrUndefined(
      decodeAuthManifest(yield* readBounded(path.join(folder, "auth.json"))),
    );
    if (auth === undefined) return undefined;
    for (const provider of Object.values(auth.providers)) {
      const clis = provider.clis ?? [];
      if (
        clis.includes(program) &&
        provider.oauth2 !== undefined &&
        endpointOf(provider.oauth2.authorizeUrl) === challenge.endpoint &&
        provider.oauth2.clientId === challenge.clientId
      ) {
        return { displayName: plugin.displayName, programs: clis } satisfies VerifiedPluginSignIn;
      }
    }
    return undefined;
  },
  Effect.orElseSucceed(() => undefined),
);
