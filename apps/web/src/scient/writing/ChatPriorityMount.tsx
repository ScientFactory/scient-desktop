import { useEffect, useState, type ReactNode } from "react";
import { afterChatInputQuiet } from "./inputPriority";

export function ChatPriorityMount({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to renderer input activity and cancels deferred mounting on unmount
  useEffect(() => afterChatInputQuiet(() => setReady(true)), []);
  return ready ? children : fallback;
}
