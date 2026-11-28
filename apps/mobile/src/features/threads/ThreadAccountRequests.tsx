import {
  accountApprovalQuestion,
  accountHandoffInstruction,
} from "@t3tools/shared/scientSignInPage";
import { BACKUP_CODE_ID, type AccountApproval, type EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { accountsEnvironment } from "../../state/accounts";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type AccountRequestsScope,
  accountRequestsIn,
  accountsErrorMessage,
  needSignIn,
} from "./accountRequests";

/**
 * What a sign-in in this thread, or in none the phone lists, is waiting on: an approval to answer
 * here, or a step to finish. A page's CAPTCHA or passkey still needs the desktop.
 */
export function ThreadAccountRequests(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: AccountRequestsScope;
}) {
  const { environmentId, scope } = props;
  const gt = useGT();
  const m = useMessages();
  const { data } = useEnvironmentQuery(accountsEnvironment.snapshot({ environmentId, input: {} }));
  const respond = useAtomCommand(accountsEnvironment.respondApproval, "Answer account request");
  const cancel = useAtomCommand(accountsEnvironment.cancelHandoff, "Cancel sign-in");
  const insert = useAtomCommand(accountsEnvironment.insertHandoffCode, "Insert sign-in code");
  const dismiss = useAtomCommand(accountsEnvironment.dismissNeedsYou, "Dismiss account request");
  const typeSaved = useAtomCommand(accountsEnvironment.typeSavedInHandoff, "Use saved password");
  const answer = (approval: AccountApproval, decision: "once" | "project" | "always" | "deny") =>
    void respond({ environmentId, input: { approvalId: approval.approvalId, decision } });
  const show = useAtomCommand(accountsEnvironment.showHandoff, "Open sign-in");
  const signInNow = useAtomCommand(accountsEnvironment.signInAsPerson, "Sign in");
  const signInBefore = useAtomCommand(accountsEnvironment.universitySignIn, "Sign in");
  // A server older than protocol 1 has the person's sign-in under its old name.
  const signIn = (data?.accountsProtocol ?? 0) >= 1 ? signInNow : signInBefore;
  const setControls = useAtomCommand(accountsEnvironment.setControls, "Turn on for agents");
  const resume = useAtomCommand(accountsEnvironment.continuePapers, "Continue papers");
  const { approvals, handoffs, needs, papers, speaks2 } = accountRequestsIn(data, scope);
  const threadId = "threadId" in scope ? scope.threadId : undefined;
  if (approvals.length === 0 && handoffs.length === 0 && needs.length === 0 && papers.length === 0)
    return null;
  return (
    <View className="gap-2 px-4 pb-2">
      {approvals.map((approval) => (
        <View
          key={approval.approvalId}
          className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
        >
          <Text className="font-t3-bold text-base text-foreground">{approval.targetName}</Text>
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {accountApprovalQuestion(approval.action, m)}
            {approval.turnOn ? ` ${gt("It's off for agents.")}` : ""}
          </Text>
          {approval.turnOn ? (
            <View className="flex-row flex-wrap gap-2">
              <Button
                label={gt("Turn on for agents")}
                tone="primary"
                onPress={() => answer(approval, "always")}
              />
              <Button
                label={gt("This conversation")}
                tone="secondary"
                onPress={() => answer(approval, "once")}
              />
              <Button label={gt("Not now")} tone="text" onPress={() => answer(approval, "deny")} />
            </View>
          ) : (
            <View className="flex-row flex-wrap gap-2">
              <Button
                label={gt("Allow", { $context: "allow this account request once" })}
                tone="primary"
                onPress={() => answer(approval, "once")}
              />
              {approval.projectId ? (
                <Button
                  label={gt("This project", { $context: "always allow in this project" })}
                  tone="secondary"
                  onPress={() => answer(approval, "project")}
                />
              ) : null}
              <Button
                label={gt("Always", { $context: "always allow this account request" })}
                tone="secondary"
                onPress={() => answer(approval, "always")}
              />
              <Button
                label={gt("Deny", { $context: "deny this account request" })}
                tone="text"
                onPress={() => answer(approval, "deny")}
              />
            </View>
          )}
        </View>
      ))}
      {handoffs.map((handoff) => (
        <View
          key={handoff.handoffId}
          className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
        >
          <Text className="font-t3-bold text-base text-foreground">{handoff.accountName}</Text>
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {accountHandoffInstruction(handoff, m)}
            {handoff.kind === "captcha" || handoff.kind === "passkey"
              ? ` · ${gt("On your computer")}`
              : ""}
          </Text>
          {handoff.reason ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              {handoff.reason}
            </Text>
          ) : null}
          {/* The server types the code; its digits never reach the phone. */}
          {(speaks2 ? (handoff.codes ?? []) : []).map((code, index, codes) => (
            <Button
              key={code.codeId}
              label={
                codes.length === 1
                  ? gt("Insert code from {source}", {
                      source: code.source === "mail" ? gt("Mail") : gt("Messages"),
                    })
                  : gt("Insert code {number} of {count}", {
                      number: index + 1,
                      count: codes.length,
                    })
              }
              tone={codes.length === 1 ? "primary" : "secondary"}
              onPress={() =>
                void insert({
                  environmentId,
                  input: { handoffId: handoff.handoffId, codeId: code.codeId },
                }).then((result) => {
                  // Another click or Scient itself may have put a code in first.
                  const message =
                    result._tag === "Failure" ? accountsErrorMessage(result.cause) : undefined;
                  if (message) Alert.alert(gt("Code not inserted"), message);
                })
              }
            />
          ))}
          {handoff.backupCodes ? (
            <Button
              label={gt("Use a backup code")}
              tone="secondary"
              onPress={() =>
                void insert({
                  environmentId,
                  input: { handoffId: handoff.handoffId, codeId: BACKUP_CODE_ID },
                }).then((result) => {
                  const message =
                    result._tag === "Failure" ? accountsErrorMessage(result.cause) : undefined;
                  if (message) Alert.alert(gt("Code not inserted"), message);
                })
              }
            />
          ) : null}
          {handoff.tabId ? (
            <Button
              label={gt("Open on the computer")}
              tone="secondary"
              onPress={() => void show({ environmentId, input: { handoffId: handoff.handoffId } })}
            />
          ) : null}
          {handoff.useSaved !== undefined && handoff.useSavedRevision !== undefined ? (
            <Button
              label={
                handoff.useSaved
                  ? gt("Use saved {username}", { username: handoff.useSaved })
                  : gt("Use saved password")
              }
              tone="primary"
              onPress={() =>
                void typeSaved({
                  environmentId,
                  input: { handoffId: handoff.handoffId, revision: handoff.useSavedRevision ?? "" },
                })
              }
            />
          ) : null}
          <Button
            label={gt("Cancel sign-in")}
            tone="text"
            onPress={() => void cancel({ environmentId, input: { handoffId: handoff.handoffId } })}
          />
        </View>
      ))}
      {/* A sign-in here, on the computer or from Accounts clears it everywhere. */}
      {needs.map((need) => {
        const signInHere = needSignIn(need, scope);
        return (
          <View
            key={need.needId}
            className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
          >
            <Text className="font-t3-bold text-base text-foreground">{need.name}</Text>
            <Text className="font-sans text-sm leading-5 text-foreground-muted">{need.detail}</Text>
            {signInHere ? (
              <Button
                label={gt("Sign in")}
                tone="primary"
                onPress={() => void signIn({ environmentId, input: signInHere })}
              />
            ) : null}
            <Button
              label={gt("Dismiss")}
              tone="text"
              onPress={() => void dismiss({ environmentId, input: { needId: need.needId } })}
            />
          </View>
        );
      })}
      {papers.map(({ root, request, accountId }) => (
        <View
          key={`${root}:${request.kind}:${accountId}`}
          className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
        >
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {request.kind === "sign-in"
              ? gt(
                  "{count, plural, one {{count} paper waits} other {{count} papers wait}} for you to sign in to {site}.",
                  { count: request.count, site: request.site ?? "" },
                )
              : gt(
                  "{count, plural, one {{count} paper waits} other {{count} papers wait}}: this conversation may not use {site}.",
                  { count: request.count, site: request.site ?? "" },
                )}
          </Text>
          <Button
            label={request.kind === "sign-in" ? gt("Sign in") : gt("Turn on for agents")}
            tone="primary"
            onPress={() =>
              void (request.kind === "sign-in"
                ? threadId && signIn({ environmentId, input: { accountId, threadId } })
                : setControls({
                    environmentId,
                    input: { target: { type: "account", accountId }, access: "allowed" },
                  }).then(() => resume({ environmentId, input: { root } })))
            }
          />
        </View>
      ))}
    </View>
  );
}
