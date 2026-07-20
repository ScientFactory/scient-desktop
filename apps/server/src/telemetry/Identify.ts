import { Effect, FileSystem, Random } from "effect";
import { ServerConfig } from "../config";

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig;

  const anonymousId = yield* fileSystem.readFileString(anonymousIdPath).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const randomId = yield* Random.nextUUIDv4;
        yield* fileSystem.writeFileString(anonymousIdPath, randomId);
        return randomId;
      }),
    ),
  );

  const trimmed = anonymousId.trim();
  if (trimmed.length > 0) return trimmed;

  const randomId = yield* Random.nextUUIDv4;
  yield* fileSystem.writeFileString(anonymousIdPath, randomId);
  return randomId;
});

/**
 * Returns a random installation-scoped identifier stored in Scient's state directory.
 * It never reads or derives identity from connected AI-provider accounts.
 */
export const getTelemetryIdentifier = Effect.gen(function* () {
  const anonymousId = yield* Effect.result(upsertAnonymousId);
  if (anonymousId._tag === "Success") {
    return `installation:${anonymousId.success}`;
  }

  return null;
}).pipe(
  Effect.tapError((error) => Effect.logWarning("Failed to get identifier", { cause: error })),
  Effect.orElseSucceed(() => null),
);
