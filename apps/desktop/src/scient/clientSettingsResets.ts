import {
  applyClientSettingsResets,
  CLIENT_SETTINGS_RESET_REVISION,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

interface ClientSettingsStore<ReadError, WriteError> {
  readonly get: Effect.Effect<Option.Option<ClientSettings>, ReadError>;
  readonly set: (settings: ClientSettings) => Effect.Effect<void, WriteError>;
}

/** Applies one-time resets to saved client settings; the revision sits beside the file. */
export const withClientSettingsResets = Effect.fn("withClientSettingsResets")(function* <
  ReadError,
  WriteError,
>(store: ClientSettingsStore<ReadError, WriteError>) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const revisionPath = path.join(
    path.dirname(environment.clientSettingsPath),
    "client-settings-resets",
  );
  const savedRevision = fileSystem.readFileString(revisionPath).pipe(
    Effect.map((raw) => Number.parseInt(raw.trim(), 10) || 0),
    Effect.orElseSucceed(() => 0),
  );
  const recordRevision = fileSystem
    .writeFileString(revisionPath, `${CLIENT_SETTINGS_RESET_REVISION}\n`)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not record the client settings reset revision.", cause),
      ),
    );
  return {
    get: Effect.all([store.get, savedRevision]).pipe(
      Effect.map(([saved, revision]) =>
        Option.map(saved, (settings) => applyClientSettingsResets(settings, revision)),
      ),
    ),
    set: (settings: ClientSettings) => store.set(settings).pipe(Effect.andThen(recordRevision)),
  } satisfies ClientSettingsStore<ReadError, WriteError>;
});
