import type { JSONContent } from "@tiptap/core";
import type { LatexVisualDocument, applyLatexVisualDocumentChange } from "./latexVisualDocument";
import type { LatexReferenceChoice } from "./latexAuthoringModel";

export type VisualProcessingInput =
  | { kind: "project"; source: string; setupSource: string }
  | {
      kind: "change";
      source: string;
      projection: LatexVisualDocument;
      content: JSONContent;
      rootSource: string | null;
      allowRootUpdates: boolean;
    }
  | { kind: "references"; source: string }
  | { kind: "bibliography"; source: string; path: string };

export type VisualProcessingOutput =
  | { kind: "project"; projection: LatexVisualDocument }
  | {
      kind: "change";
      change: ReturnType<typeof applyLatexVisualDocumentChange>;
      notices: string[];
    }
  | { kind: "references"; choices: LatexReferenceChoice[] }
  | { kind: "bibliography"; choices: LatexReferenceChoice[] };

export type VisualChangeInput = Extract<VisualProcessingInput, { kind: "change" }>;
export type VisualChangeDelta = {
  kind: "change-delta";
  base: number;
  prefix: number;
  suffix: number;
  content: JSONContent;
  rootSource: string | null;
  allowRootUpdates: boolean;
};

export type VisualProcessingRequest = {
  id: number;
  input: VisualProcessingInput | VisualChangeDelta;
};
export type VisualProcessingReply = {
  id: number;
  output: VisualProcessingOutput | null;
  needsFull?: boolean;
  contentMatchesInput?: boolean;
};
