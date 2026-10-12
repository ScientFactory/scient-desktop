import { createContext } from "react";

/** Carries scroll ownership and parent interaction markers through React portals. */
export const OverlayScrollScope = createContext<{
  id: string;
  portalProps?: Readonly<Record<`data-${string}`, string>>;
} | null>(null);
