import { createContext, useContext, type ReactNode } from "react";
import type { ContentDirection } from "@t3tools/contracts/settings";

const ContentDirectionContext = createContext<ContentDirection>("auto");

export function ContentDirectionScope({
  direction,
  children,
}: {
  readonly direction: ContentDirection;
  readonly children: ReactNode;
}) {
  return <ContentDirectionContext value={direction}>{children}</ContentDirectionContext>;
}

export function useContentDirection(): ContentDirection {
  return useContext(ContentDirectionContext);
}
