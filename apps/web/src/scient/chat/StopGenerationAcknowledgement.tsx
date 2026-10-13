import type { ReactNode } from "react";

/** Keep the status with its retry action without remounting the focused button. */
export function StopGenerationAcknowledgement(props: { isStopping: boolean; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {props.isStopping ? (
        <span role="status" className="whitespace-nowrap text-muted-foreground text-xs">
          Stopping…
        </span>
      ) : null}
      {props.children}
    </div>
  );
}
