import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";
import { bibliographyChoices, documentReferenceChoices } from "./latexAuthoringModel";
import type { VisualProcessingRequest, VisualProcessingReply } from "./visualProcessingProtocol";

self.addEventListener("message", (event: MessageEvent<VisualProcessingRequest>) => {
  const { id, input } = event.data;
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
  self.postMessage(reply);
});
self.postMessage({ ready: true });
