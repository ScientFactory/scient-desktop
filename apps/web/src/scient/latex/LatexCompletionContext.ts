import { createContext } from "react";
import type { LatexCompletionContext } from "./latexCommandCompletion";

export const LatexCommandContext = createContext<LatexCompletionContext>({});
