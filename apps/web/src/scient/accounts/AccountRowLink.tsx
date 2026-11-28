import { Link } from "@tanstack/react-router";
import { AccountId, EnvironmentId } from "@t3tools/contracts";
import { parseAccountLinkHref } from "@t3tools/shared/scientAccountLinks";
import type { ReactNode } from "react";
import { accountEditorLink } from "./accountsLink";

/** An agent's link to a row it saved: opens that row in Accounts on its computer. */
export function AccountRowLink({ href, children }: { href: string; children: ReactNode }) {
  const link = parseAccountLinkHref(href);
  if (!link) return <span>{children}</span>;
  return (
    <Link
      {...accountEditorLink(EnvironmentId.make(link.environmentId), AccountId.make(link.accountId))}
      className="underline"
    >
      {children}
    </Link>
  );
}
