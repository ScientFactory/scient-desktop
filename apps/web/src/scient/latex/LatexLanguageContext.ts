import { createContext } from "react";

/** The root document owns generated labels; editor chrome keeps the app's language. */
export const LatexLanguageContext = createContext("english");
