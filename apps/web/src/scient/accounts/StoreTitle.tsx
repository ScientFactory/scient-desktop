import { KeyRoundIcon } from "lucide-react";
import { AccountLogo } from "./AccountLogo";
import { accountIconUrl } from "./accountsView";

export function StoreTitle({
  name,
  status,
  domain,
}: {
  name: string;
  status: string;
  domain?: string | undefined;
}) {
  const icon = accountIconUrl(domain ? [domain] : [], name);
  return (
    <span className="flex min-w-0 items-center gap-3">
      {icon ? (
        <AccountLogo src={icon} className="size-9 rounded-lg" />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
        </span>
      )}
      <span className="grid min-w-0 gap-1">
        <span>{name}</span>
        <span className="truncate text-xs text-muted-foreground">{status}</span>
      </span>
    </span>
  );
}
