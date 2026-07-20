import { Effect, Logger } from "effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config";
import { ensurePrivateDirectorySync } from "./privatePathPermissions";

export const ServerLoggerLive = Effect.gen(function* () {
  const { logsDir, serverLogPath } = yield* ServerConfig;

  // Keep the logger safe in isolation as well as behind normal config startup.
  yield* Effect.sync(() => ensurePrivateDirectorySync(logsDir));

  const fileLogger = Logger.formatSimple.pipe(Logger.toFile(serverLogPath));

  return Logger.layer([Logger.defaultLogger, fileLogger], {
    mergeWithExisting: false,
  });
}).pipe(Layer.unwrap);
