// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

import * as CloudWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "ScientCloud",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* CloudWorker.Worker;
    return { workerName: worker.workerName, url: worker.url };
  }).pipe(Effect.provide(CloudWorker.layer)),
);
