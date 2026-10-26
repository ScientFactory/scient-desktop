import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

/**
 * One tooltip timing for the whole app: tooltips open after 0.1s, and at once while
 * moving between controls. A place that sets its own timing keeps it. Base UI's
 * provider is imported directly, which keeps the app's entry imports light.
 */
export function AppTooltipTiming({ children }: { readonly children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delay={100} closeDelay={0} timeout={400}>
      {children}
    </TooltipPrimitive.Provider>
  );
}
