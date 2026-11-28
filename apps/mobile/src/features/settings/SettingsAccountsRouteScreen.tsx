import { loginGroups } from "@t3tools/shared/scientLoginIdentity";
import { AsyncResult } from "effect/reactivity";
import { ACCOUNTS_PROTOCOL_2, type AccountSummary, type EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import type { StaticScreenProps } from "@react-navigation/native";
import type { ComponentProps } from "react";
import { useGT, useMessages } from "gt-react-native";
import { passwordFindingLabel } from "@t3tools/shared/scientSignInPage";
import { Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { Menu } from "../../components/ui/Menu";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { accountsEnvironment } from "../../state/accounts";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { HomeAccountWaits } from "../home/HomeAccountWaits";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Accounts & secrets on the phone: the agent switch, one row per saved login and per key, each
 * with Check and its agent access. Adding, editing and removing stay on the computer.
 */
type ListRowProps = ComponentProps<typeof ListRow>;

export function SettingsAccountsRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const { environmentId } = route.params;
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const { data } = useEnvironmentQuery(accountsEnvironment.snapshot({ environmentId, input: {} }));
  const threads = useThreadShells();
  const setAgentAccess = useAtomCommand(accountsEnvironment.setAgentAccess, "Agent access");
  const setRenew = useAtomCommand(accountsEnvironment.setRenewAutomatically, "Renewal");
  const setControls = useAtomCommand(accountsEnvironment.setControls, "Agent access");
  const check = useAtomCommand(accountsEnvironment.check, "Check account");
  const test = useAtomCommand(accountsEnvironment.test, "Check account");
  const reveal = useAtomCommand(accountsEnvironment.reveal, "Show password");
  const accounts = data?.accounts ?? [];
  // An older server writes a password to one row: its copies are listed one by one.
  const grouped = data ? (data.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2 : false;
  const logins = grouped
    ? loginGroups(accounts)
    : accounts
        .filter(
          (account) => account.details.kind === "website" && account.secrets.password !== undefined,
        )
        .map((account) => [account]);
  const keys = accounts.filter((account) => account.details.kind === "api-key");
  const state = (account: AccountSummary) =>
    account.controls.access === "off"
      ? gt("Off for agents")
      : account.secrets.password?.refusedAt !== undefined ||
          account.signIn?.state === "password-rejected"
        ? gt("Password refused")
        : account.signIn?.state === "signed-in"
          ? gt("Signed in")
          : account.signIn?.state === "signed-out"
            ? gt("Signed out")
            : account.signIn?.unreachable
              ? gt("Can't reach")
              : account.status === "needs-attention"
                ? gt("Needs attention")
                : undefined;
  const setAccess = (copies: ReadonlyArray<AccountSummary>, access: "allowed" | "off") => {
    for (const copy of copies)
      void setControls({
        environmentId,
        input: { target: { type: "account", accountId: copy.accountId }, access },
      });
  };
  // The person's own Show or Copy, recorded in the row's Activity.
  const password = async (account: AccountSummary) => {
    const result = await reveal({
      environmentId,
      input: { accountId: account.accountId, field: "password" },
    });
    return AsyncResult.isSuccess(result) ? result.value.value : undefined;
  };
  // Every action in the menu: a native alert keeps only three buttons on Android.
  const actionsOf = (copies: ReadonlyArray<AccountSummary>): MenuAction[] => [
    { id: "check", title: gt("Check") },
    ...(copies.some((copy) => copy.controls.access === "off")
      ? [{ id: "on", title: gt("Turn on for agents") }]
      : []),
    ...(copies.some((copy) => copy.controls.access !== "off")
      ? [{ id: "off", title: gt("Turn off for agents") }]
      : []),
    ...(copies[0]!.details.kind === "website" && grouped
      ? [
          { id: "show", title: gt("Show password") },
          { id: "copy", title: gt("Copy password") },
        ]
      : []),
  ];
  const act = (copies: ReadonlyArray<AccountSummary>, action: string) => {
    const first = copies[0]!;
    if (action === "check" && first.details.kind !== "website")
      // "Works" only once its service accepted the key; a value that only reads says so.
      void test({ environmentId, input: { accountId: first.accountId } }).then((result) => {
        if (!AsyncResult.isSuccess(result)) return;
        Alert.alert(
          first.name,
          result.value.result === "works"
            ? gt("Works")
            : result.value.result === "refused"
              ? gt("Key refused")
              : gt("Value readable"),
        );
      });
    else if (action === "check")
      for (const copy of copies)
        void check({ environmentId, input: { accountId: copy.accountId } });
    else if (action === "on" || action === "off")
      setAccess(copies, action === "on" ? "allowed" : "off");
    else if (action === "show")
      void password(first).then((value) => {
        if (value !== undefined) Alert.alert(first.name, value);
      });
    else if (action === "copy")
      void password(first).then((value) => {
        if (value !== undefined) void tryCopyTextWithHaptic(value, { target: "password" });
      });
  };
  const row = (copies: ReadonlyArray<AccountSummary>, props: Omit<ListRowProps, "onPress">) => (
    <Menu
      key={copies[0]!.accountId}
      title={copies[0]!.name}
      actions={actionsOf(copies)}
      onPressAction={({ nativeEvent }) => act(copies, nativeEvent.event)}
    >
      <ListRow {...props} onPress={() => undefined} />
    </Menu>
  );
  return (
    <SettingsScreen title={gt("Accounts & secrets")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!data ? (
          <Text className="px-2 text-sm text-foreground-muted">{gt("Loading…")}</Text>
        ) : (
          <>
            {/* What waits for the person with no chat here to show it, as on Home. */}
            <HomeAccountWaits environmentIds={[environmentId]} threads={threads} placement="list" />
            <SettingsSection title={gt("Agents")}>
              <ListToggleRow
                label={gt("Let agents use your accounts")}
                value={data.agentAccess}
                onValueChange={(enabled) =>
                  void setAgentAccess({ environmentId, input: { enabled } })
                }
              />
            </SettingsSection>
            {data.renewAutomatically === undefined ? null : (
              <SettingsSection title={gt("Sign-ins")}>
                <ListToggleRow
                  label={gt("Renew sign-ins automatically")}
                  value={data.renewAutomatically}
                  onValueChange={(enabled) => void setRenew({ environmentId, input: { enabled } })}
                />
              </SettingsSection>
            )}
            {logins.length > 0 ? (
              <SettingsSection title={gt("Saved passwords")}>
                {logins.map((copies) => {
                  const first = copies[0]!;
                  const username =
                    first.details.kind === "website" ? first.details.username : undefined;
                  const finding = data?.passwordHealth?.find(
                    (entry) => entry.accountId === first.accountId,
                  )?.finding;
                  const detail = state(first) ?? (finding && passwordFindingLabel(finding, m));
                  return row(copies, {
                    label: first.name,
                    ...(username || copies.length > 1
                      ? {
                          description: [
                            username,
                            copies.length > 1
                              ? gt("{count} copies", { count: copies.length })
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · "),
                        }
                      : {}),
                    ...(detail ? { detail } : {}),
                  });
                })}
              </SettingsSection>
            ) : null}
            {keys.length > 0 ? (
              <SettingsSection title={gt("API keys")}>
                {keys.map((key) => {
                  const detail = state(key);
                  return row([key], { label: key.name, ...(detail ? { detail } : {}) });
                })}
              </SettingsSection>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
