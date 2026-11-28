import {
  ACCOUNTS_PROTOCOL_2,
  AccountId,
  DEFAULT_BROWSER_PROFILE_ID,
  PreviewTabId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { signInChoiceLabels, signInsForTab } from "@t3tools/shared/scientAccountSignIn";
import { useGT } from "gt-react-native";

import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { accountsEnvironment } from "../../state/accounts";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The key on a tab the server runs: Scient signs the person in there with a saved login, on the
 * server, so no password reaches the phone. Hidden where the page has none.
 */
export function BrowserSignInKey(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly url: string;
  readonly profileId: string | undefined;
}) {
  const gt = useGT();
  const { data } = useEnvironmentQuery(
    accountsEnvironment.snapshot({ environmentId: props.environmentId, input: {} }),
  );
  const signIn = useAtomCommand(accountsEnvironment.signInAsPerson, "Sign in");
  if (!data || (data.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL_2 || !URL.canParse(props.url))
    return null;
  const logins = signInsForTab(
    data.accounts,
    props.url,
    props.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
  );
  if (logins.length === 0) return null;
  const labels = signInChoiceLabels(logins);
  return (
    <Menu
      accessible
      accessibilityLabel={gt("Saved sign-ins")}
      accessibilityRole="button"
      actions={logins.map((account) => ({
        id: account.accountId,
        title: labels.get(account.accountId) || account.name,
      }))}
      onPressAction={({ nativeEvent }) =>
        void signIn({
          environmentId: props.environmentId,
          input: {
            accountId: AccountId.make(nativeEvent.event),
            threadId: props.threadId,
            tabId: PreviewTabId.make(props.tabId),
          },
        })
      }
    >
      <ControlPill icon="person.crop.circle" accessibilityLabel={gt("Saved sign-ins")} />
    </Menu>
  );
}
