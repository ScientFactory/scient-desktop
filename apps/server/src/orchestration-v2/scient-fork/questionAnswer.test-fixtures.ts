import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";

export function questionAnswerActivity(
  turnId: string | null,
  id = "answer-1",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "user-input.answer-submitted",
    summary: "Question answer submitted",
    tone: "info",
    turnId: turnId === null ? null : TurnId.make(turnId),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      requestId: "request-1",
      answers: { dataset: "Use the measured data" },
      questionTextById: { dataset: "Which dataset?" },
      attachmentsByQuestionId: {
        dataset: [
          {
            type: "file",
            id: "origin-thread-00000000-0000-4000-8000-000000000001-csv",
            name: "measurements.csv",
            mimeType: "text/csv",
            sizeBytes: 4,
          },
        ],
      },
    },
  };
}
