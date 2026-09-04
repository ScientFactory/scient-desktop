import { ScientQueueWorker } from "../../scient/threadQueue/Worker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
// SCIENT-FORK:START
import { ScientForkReactor } from "../Services/ScientForkReactor.ts";
// SCIENT-FORK:END
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  // SCIENT-FORK:START
  const scientForkReactor = yield* ScientForkReactor;
  // SCIENT-FORK:END
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const queueWorker = yield* ScientQueueWorker;
  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    // SCIENT-FORK:START
    yield* scientForkReactor.start();
    // SCIENT-FORK:END
    yield* threadDeletionReactor.start();
    yield* threadSettlementReactor.start();
    yield* agentAwarenessRelay.start();
    yield* queueWorker.start;
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
