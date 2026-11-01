import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "../scient/accounts/AccountsPage";

export const Route = createFileRoute("/_chat/settings/accounts")({ component: AccountsPage });
