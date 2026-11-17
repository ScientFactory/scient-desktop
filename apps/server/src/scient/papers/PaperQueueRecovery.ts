import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { forkParked } from "../../serverActivation.ts";
import { AccountsService } from "../accounts/AccountsService.ts";
import { showPapersAfterRestart } from "./getPaper.ts";

/** After activation, so the first screens load before the queues are read. */
const SHOW_DELAY = "5 seconds";

/** Papers that waited on the user before a restart ask again, wherever the user looks. */
export const paperQueueRecoveryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment;
    const services = yield* Effect.context<AccountsService | FileSystem.FileSystem | Path.Path>();
    yield* forkParked(
      Effect.sleep(SHOW_DELAY).pipe(
        Effect.andThen(environment.getEnvironmentId),
        Effect.flatMap(showPapersAfterRestart),
        Effect.provideContext(services),
      ),
    );
  }),
);
