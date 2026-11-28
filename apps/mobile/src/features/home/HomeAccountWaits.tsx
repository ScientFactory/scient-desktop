import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { ThreadAccountRequests } from "../threads/ThreadAccountRequests";

/**
 * What a sign-in with no chat the phone lists waits on, for each connected environment. Home
 * mounts it wherever it draws, the empty screens included, so a renewal's code is never missed.
 */
export function HomeAccountWaits(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** In the thread list's header, or above an empty home or an empty filtered list. */
  readonly placement: "list" | "empty-home" | "empty-list";
}) {
  return (
    <View className={props.placement === "list" ? undefined : "w-full self-stretch"}>
      {props.environmentIds.map((environmentId) => (
        <ThreadAccountRequests
          key={environmentId}
          environmentId={environmentId}
          scope={{
            outside: new Set(
              props.threads
                .filter((thread) => thread.environmentId === environmentId)
                .map((thread) => thread.id),
            ),
          }}
        />
      ))}
    </View>
  );
}
