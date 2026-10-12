import type { MacroDictionary } from "mathlive";
import type { DocumentMathMacro } from "./latexDocumentMacros";

export type MathPreviewContext = {
  macros: MacroDictionary;
  documentMacros: Readonly<Record<string, DocumentMathMacro>>;
  colors: Readonly<Record<string, string>> | undefined;
};
export type MathPreviewRequest = {
  id: number;
  source: string;
  display: boolean;
  contextId: number;
  resetContexts?: boolean;
  context?: MathPreviewContext;
};
