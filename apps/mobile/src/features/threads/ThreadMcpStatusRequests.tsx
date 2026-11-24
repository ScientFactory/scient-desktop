import {
  isActionableThreadMcpStatus,
  isProminentThreadMcpIssue,
  type EnvironmentId,
  type ThreadId,
  type ThreadMcpServerObservation,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentQuery } from "../../state/query";
import { threadMcpStatus } from "../../state/threadMcpStatus";
import { threadEnvironment } from "../../state/threads";
import { McpSignInSheet, type McpSignInTarget } from "./McpSignInSheet";

const nativeSignInTarget = (
  threadId: ThreadId,
  server: ThreadMcpServerObservation,
): McpSignInTarget | null =>
  server.source !== "managed" &&
  server.status === "needs-sign-in" &&
  server.sessionActive &&
  server.providerThreadId !== undefined
    ? { threadId, providerThreadId: server.providerThreadId, server: server.name }
    : null;

/**
 * The thread's MCP servers that need the person: an agent's own server signs in here; a Scient
 * connector is fixed on the computer that runs it.
 */
export function ThreadMcpStatusRequests(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const gt = useGT();
  const { data } = useEnvironmentQuery(threadMcpStatus({ environmentId, input: { threadId } }));
  const canSignIn = useAtomValue(threadEnvironment.mcpSignInStart.permissionAtom(environmentId));
  const [signIn, setSignIn] = useState<McpSignInTarget | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [showOptional, setShowOptional] = useState(false);
  const servers = data?.servers ?? [];
  const issues = servers.filter(
    (server) =>
      isProminentThreadMcpIssue(server) && !dismissed.has(`${server.id}\u0000${server.status}`),
  );
  // Plugin and claude.ai servers nobody connected yet: counted, and listed only on request.
  const optional = servers.filter(
    (server) =>
      !isProminentThreadMcpIssue(server) &&
      isActionableThreadMcpStatus(server.status) &&
      (canSignIn ? nativeSignInTarget(threadId, server) : null) !== null,
  );
  if (issues.length === 0 && optional.length === 0 && signIn === null) return null;
  return (
    // Bounded, so many failing servers never push the conversation or composer off screen.
    <ScrollView className="max-h-64 shrink-0" contentContainerClassName="gap-2 px-4 pb-2">
      {issues.map((server) => {
        const target = canSignIn ? nativeSignInTarget(threadId, server) : null;
        return (
          <View
            key={server.id}
            className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
          >
            <Text className="font-t3-bold text-base text-foreground">{server.displayName}</Text>
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              {server.status === "needs-sign-in"
                ? target !== null
                  ? gt("This MCP server needs a sign-in before the agent can use it.")
                  : server.source === "managed"
                    ? gt("Sign in to this connector in Scient on your computer.")
                    : gt("Send a message to wake this session, then sign in here.")
                : (server.detail ?? gt("This MCP server isn't available in this chat."))}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {target !== null ? (
                <Button
                  label={gt("Sign in", { $context: "sign in to an MCP server" })}
                  tone="primary"
                  onPress={() => setSignIn(target)}
                />
              ) : null}
              <Button
                label={gt("Dismiss", { $context: "hide this MCP server notice" })}
                tone="text"
                onPress={() =>
                  setDismissed((current) =>
                    new Set(current).add(`${server.id}\u0000${server.status}`),
                  )
                }
              />
            </View>
          </View>
        );
      })}
      {optional.length > 0 ? (
        <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
          <Button
            label={gt("Optional servers not signed in: {count}", { count: optional.length })}
            tone="text"
            onPress={() => setShowOptional((current) => !current)}
          />
          {showOptional
            ? optional.map((server) => {
                const target = nativeSignInTarget(threadId, server);
                return target === null ? null : (
                  <View key={server.id} className="flex-row items-center justify-between gap-2">
                    <Text className="shrink font-sans text-sm text-foreground">
                      {server.displayName}
                    </Text>
                    <Button
                      label={gt("Sign in", { $context: "sign in to an MCP server" })}
                      tone="secondary"
                      onPress={() => setSignIn(target)}
                    />
                  </View>
                );
              })
            : null}
        </View>
      ) : null}
      {signIn !== null ? (
        <McpSignInSheet
          environmentId={environmentId}
          target={signIn}
          onClose={() => setSignIn(null)}
        />
      ) : null}
    </ScrollView>
  );
}
