import { KeyRoundIcon } from "lucide-react";
import { AccountLogo } from "./AccountLogo";
import { accountIconUrl } from "./accountsView";

export function StoreTitle({
  name,
  status,
  domain,
}: {
  name: string;
  status?: string | undefined;
  domain?: string | undefined;
}) {
  const icon = accountIconUrl(domain ? [domain] : [], name);
  return (
    <span className="flex min-w-0 items-center gap-3">
      {icon ? (
        <AccountLogo src={icon} className="size-10 rounded-[25%]" />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
        </span>
      )}
      <span className="grid min-w-0 gap-1">
        <span>{name}</span>
        {status ? <span className="truncate text-xs text-muted-foreground">{status}</span> : null}
      </span>
    </span>
  );
}
