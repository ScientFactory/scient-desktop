import { usableRegistryContactEmail, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { setRegistryContactEmail } from "./metadataHttp.ts";

const apply = (settings: ServerSettings) =>
  Effect.sync(() =>
    setRegistryContactEmail(
      usableRegistryContactEmail(settings.scientSources.registryContactEmail),
    ),
  );

/** Keeps every registry request's contact email in step with the Library settings. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.streamChanges.pipe(Stream.runForEach(apply), Effect.forkScoped);
    yield* settings.getSettings.pipe(Effect.flatMap(apply), Effect.ignore);
  }),
);
