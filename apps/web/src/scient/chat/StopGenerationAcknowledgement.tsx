import type { ReactNode } from "react";

/** Keep the status with its retry action when a parent distributes footer controls. */
export function StopGenerationAcknowledgement(props: { isStopping: boolean; children: ReactNode }) {
  return props.isStopping ? (
    <div className="flex shrink-0 items-center gap-2">
      <span role="status" className="whitespace-nowrap text-muted-foreground text-xs">
        Stopping…
      </span>
      {props.children}
    </div>
  ) : (
    props.children
  );
}
