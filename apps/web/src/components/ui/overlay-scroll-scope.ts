import { createContext } from "react";

/** Carries scroll ownership through React portals without admitting unrelated overlays. */
export const OverlayScrollScope = createContext<string | null>(null);
