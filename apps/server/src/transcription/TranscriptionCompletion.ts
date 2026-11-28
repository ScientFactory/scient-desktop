import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as Notes from "./RecordingNotes.ts";
import { RevisionId, TranscriptionJobs, type SettledTranscription } from "./TranscriptionJobs.ts";

const isRevisionId = Schema.is(RevisionId);

/** A completed lesson gets its notes, written by a thread of their own. */
const makeLessonNotes = ({ id, stage, lesson }: SettledTranscription) =>
  lesson && stage === "completed" && isRevisionId(id)
    ? Notes.execute({ action: "make", project: lesson.project, id, recipe: "lesson" }).pipe(
        Effect.catchCause(() => Effect.logWarning("Could not make the lesson notes", { id })),
      )
    : Effect.void;

export const completionCommand = ({
  threadId,
  id,
  stage,
}: SettledTranscription & { threadId: ThreadId }) => {
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
      Stream.runForEach((settled) => {
        const { threadId } = settled;
        const notify = threadId
          ? threads.dispatch(completionCommand({ ...settled, threadId })).pipe(
              Effect.catchCause(() =>
                Effect.logWarning("Could not notify the transcription thread", {
                  id: settled.id,
                  stage: settled.stage,
                }),
              ),
            )
          : Effect.void;
        return notify.pipe(Effect.andThen(makeLessonNotes(settled)));
      }),
      Effect.forkScoped,
    );
  }),
);
