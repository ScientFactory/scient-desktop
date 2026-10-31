import {
  accountApprovalQuestion,
  accountHandoffInstruction,
} from "@t3tools/shared/scientSignInPage";
import type { AccountApproval, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { accountsEnvironment } from "../../state/accounts";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * What a sign-in in this thread is waiting on: an approval to answer here, or a step to finish.
 * A code also has its private card; a page's CAPTCHA or passkey still needs the desktop.
 */
export function ThreadAccountRequests(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const { data } = useEnvironmentQuery(accountsEnvironment.snapshot({ environmentId, input: {} }));
  const respond = useAtomCommand(accountsEnvironment.respondApproval, "Answer account request");
  const cancel = useAtomCommand(accountsEnvironment.cancelHandoff, "Cancel sign-in");
  const answer = (approval: AccountApproval, decision: "once" | "always" | "deny") =>
    void respond({ environmentId, input: { approvalId: approval.approvalId, decision } });
  const approvals = data?.approvals.filter((item) => item.threadId === threadId) ?? [];
  // A code has its own private card; the rest are shown here.
  const handoffs =
    data?.handoffs?.filter((item) => item.threadId === threadId && item.kind !== "code") ?? [];
  if (approvals.length === 0 && handoffs.length === 0) return null;
  return (
    <View className="gap-2 px-4 pb-2">
      {approvals.map((approval) => (
        <View
          key={approval.approvalId}
          className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
        >
          <Text className="font-t3-bold text-base text-foreground">{approval.targetName}</Text>
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {accountApprovalQuestion(approval.action)}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button label="Allow" tone="primary" onPress={() => answer(approval, "once")} />
            <Button label="Always" tone="secondary" onPress={() => answer(approval, "always")} />
            <Button label="Deny" tone="text" onPress={() => answer(approval, "deny")} />
          </View>
        </View>
      ))}
      {handoffs.map((handoff) => (
        <View
          key={handoff.handoffId}
          className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
        >
          <Text className="font-t3-bold text-base text-foreground">{handoff.accountName}</Text>
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {accountHandoffInstruction(handoff.kind)}
            {handoff.kind === "push" && handoff.number ? ` Tap ${handoff.number}.` : ""}
            {handoff.kind === "captcha" || handoff.kind === "passkey" ? " On your computer." : ""}
          </Text>
          <Button
            label="Cancel sign-in"
            tone="text"
            onPress={() => void cancel({ environmentId, input: { handoffId: handoff.handoffId } })}
          />
        </View>
      ))}
    </View>
  );
}
