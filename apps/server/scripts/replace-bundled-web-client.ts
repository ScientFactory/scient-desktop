// FILE: replace-bundled-web-client.ts
// Purpose: Replaces the bundled web client without retaining files from older builds.

import { Effect, FileSystem } from "effect";

export const replaceBundledWebClient = Effect.fn("replaceBundledWebClient")(function* (
  webDist: string,
  clientTarget: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(webDist))) {
    return false;
  }

  yield* fs.remove(clientTarget, { force: true, recursive: true });
  yield* fs.copy(webDist, clientTarget);
  return true;
});
