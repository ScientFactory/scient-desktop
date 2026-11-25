import { createContext } from "react";

export const GridActionMenuContext = createContext<{
  readonly finalFocus: () => HTMLButtonElement | null;
  readonly launch: (open: () => void) => void;
} | null>(null);
