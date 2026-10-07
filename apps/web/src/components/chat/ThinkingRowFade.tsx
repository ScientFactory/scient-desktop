import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { useStreamingTextAppearing } from "./useStreamingBlockEntrance";

/**
 * The live "Thinking" row, out of the way while the answer right above it is
 * appearing line by line: the flowing text shows the work. It fades out
 * (keeping its place) and returns when the agent thinks or uses tools again.
 */
export function ThinkingRowFade({
  answerId,
  children,
}: {
  answerId: string | null;
  children: ReactNode;
}) {
  const answerAppearing = useStreamingTextAppearing(answerId);
  return (
    <div
      className={cn(
        "transition-opacity duration-300 ease-in-out motion-reduce:transition-none",
        answerAppearing && "opacity-0",
      )}
      aria-hidden={answerAppearing || undefined}
      inert={answerAppearing || undefined}
    >
      {children}
    </div>
  );
}
