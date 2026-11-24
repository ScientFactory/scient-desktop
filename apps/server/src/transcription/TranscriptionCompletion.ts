import { CommandId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { TranscriptionJobs, type SettledTranscription } from "./TranscriptionJobs.ts";

export const completionCommand = ({ threadId, id, stage }: SettledTranscription) => {
  const key = `transcription:${threadId}:${id}:${stage}`;
  const summary = `Transcription ${stage}.`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(key),
    threadId,
    messageId: MessageId.make(key),
    text: `${summary} Check job ${id} with scient_transcription_status.`,
    notification: {
      source: { kind: "background_task" },
      outcome: stage === "canceled" ? "cancelled" : stage,
      summary,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  } as const;
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* TranscriptionJobs;
    const threads = yield* ThreadManagementService;
    const subscription = yield* jobs.subscribeSettled();
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((settled) =>
        threads.dispatch(completionCommand(settled)).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Could not notify the transcription thread", {
              id: settled.id,
              stage: settled.stage,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
