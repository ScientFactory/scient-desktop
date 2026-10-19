import { createContext } from "react";
import type { DocumentMathMacro } from "./latexDocumentMacros";

/** All equation node views inherit the same root document declarations. */
export const LatexDocumentMathContext = createContext<Readonly<Record<string, DocumentMathMacro>>>(
  {},
);
