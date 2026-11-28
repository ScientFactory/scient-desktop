import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "../scient/accounts/AccountsPage";
import { accountsSearch } from "../scient/accounts/accountsLink";

function SettingsAccountsRoute() {
  return <AccountsPage link={Route.useSearch()} />;
}

export const Route = createFileRoute("/_chat/settings/accounts")({
  validateSearch: accountsSearch,
  component: SettingsAccountsRoute,
});
