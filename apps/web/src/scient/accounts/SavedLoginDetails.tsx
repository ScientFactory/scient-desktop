import { T, useGT, useMessages } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useLoginActions } from "./loginActions";
import { loginState, type SavedLogin } from "./savedLogins";

/**
 * A login opened in place in Saved passwords: its username, password with Show and Copy, sites,
 * profiles and how it last did, with Edit and Remove. No dialog opens for any of it.
 */
export function SavedLoginDetails({
  environmentId,
  login,
  profileName,
  canWrite,
  onEdit,
}: {
  environmentId: EnvironmentId;
  login: SavedLogin;
  profileName: (profileId: string) => string | undefined;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const actions = useLoginActions(environmentId);
  const [shown, setShown] = useState<string | null>(null);
  const { account, copies } = login;
  const details = account.details;
  const state = loginState(copies);
  const label = (text: string) => <dt className="text-muted-foreground">{text}</dt>;
  return (
    <div className="border-t bg-muted/20 px-4 py-3 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
        {label(gt("Username"))}
        <dd className="truncate">
          {(details.kind === "website" ? details.username : undefined) ?? gt("No username")}
        </dd>
        {label(gt("Password"))}
        <dd className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{shown ?? "••••••••"}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={!canWrite}
            aria-label={shown === null ? gt("Show password") : gt("Hide password")}
            onClick={async () => {
              if (shown !== null) return setShown(null);
              const password = await actions.reveal(account.accountId);
              if (password !== undefined) setShown(password);
            }}
          >
            {shown === null ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={!canWrite}
            aria-label={gt("Copy password")}
            onClick={() => void actions.copy(account.accountId)}
          >
            <CopyIcon />
          </Button>
        </dd>
        {label(gt("Site"))}
        <dd className="truncate">{"sites" in details ? details.sites.join(", ") : ""}</dd>
        {label(gt("Profiles"))}
        <dd className="truncate">
          {login.profileIds.map(profileName).filter(Boolean).join(", ") || gt("New tabs profile")}
        </dd>
        {state.refused || state.workedAt ? (
          <>
            {label(gt("Status"))}
            <dd>
              {state.refused
                ? gt("Refused")
                : gt("Worked {time}", {
                    time: formatRelativeTimeLabel(state.workedAt!, undefined, messages),
                  })}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="mt-3 flex gap-2">
        <Button size="xs" variant="outline" disabled={!canWrite} onClick={onEdit}>
          <T>Edit</T>
        </Button>
        {actions.remove ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!canWrite}
            onClick={() =>
              void actions.remove?.(
                copies,
                (details.kind === "website" ? details.username : undefined) ?? account.name,
              )
            }
          >
            <T>Remove</T>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
