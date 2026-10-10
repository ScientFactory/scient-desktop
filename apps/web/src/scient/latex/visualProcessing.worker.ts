import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";
import { bibliographyChoices, documentReferenceChoices } from "./latexAuthoringModel";
import type { VisualProcessingRequest, VisualProcessingReply } from "./visualProcessingProtocol";
import { createVisualProcessingState } from "./visualProcessingState";

const state = createVisualProcessingState();

self.addEventListener("message", (event: MessageEvent<VisualProcessingRequest>) => {
  const { id } = event.data;
  const input =
    event.data.input.kind === "change-delta" ? state.expand(event.data.input) : event.data.input;
  if (!input) {
    self.postMessage({ id, output: null, needsFull: true } satisfies VisualProcessingReply);
    return;
  }
  const reply: VisualProcessingReply = { id, output: null };
  try {
    if (input.kind === "project")
      reply.output = {
        kind: "project",
        projection: projectLatexVisualDocument(input.source, 0, input.setupSource),
      };
    else if (input.kind === "references")
      reply.output = { kind: "references", choices: documentReferenceChoices(input.source) };
    else if (input.kind === "bibliography")
      reply.output = {
        kind: "bibliography",
        choices: bibliographyChoices(input.source, input.path),
      };
    else {
      const notices: string[] = [];
      reply.output = {
        kind: "change",
        change: applyLatexVisualDocumentChange(input.source, input.projection, input.content, {
          rootSource: input.rootSource,
          allowRootUpdates: input.allowRootUpdates,
          onMissingRequirement: (notice) => notices.push(notice),
        }),
        notices,
      };
    }
  } catch {
    // Failure transfers no source ownership; the renderer retains its live draft.
  }
  try {
    if (reply.output?.kind === "project") state.retain(id, reply.output.projection);
    else if (reply.output?.kind === "change" && reply.output.change)
      state.retain(id, reply.output.change.projection);
    if (input.kind === "change" && reply.output?.kind === "change" && reply.output.change)
      reply.contentMatchesInput = reply.output.change.projection.content === input.content;
  } catch {
    // Cache failure does not discard an otherwise valid result. A missing base
    // causes the next request to retry its full, revision-checked input.
  }
  self.postMessage(reply);
});
self.postMessage({ ready: true });
