import { msg, T, useGT, useMessages } from "gt-react";
import { EyeIcon, EyeOffIcon, KeyRoundIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { m, type MessageResolver } from "~/i18n/messages";

export interface SignInKeyRow {
  readonly accountId: string;
  readonly username: string;
  /** The profile it belongs to, named only where that tells rows apart. */
  readonly profile?: string | undefined;
}

const rowLabel = (row: SignInKeyRow, resolve: MessageResolver = m) => {
  const username = row.username || resolve(msg("No username"));
  return row.profile ? `${username} · ${row.profile}` : username;
};

/**
 * The address bar's key, as in Chrome: the saved sign-in Scient filled, its password on request,
 * and the site's other saved sign-ins to fill instead. Passwords stay in the app, never the page.
 */
export function SignInKey({
  site,
  rows,
  filledId,
  busy,
  onFill,
  onReveal,
  onEdit,
}: {
  site: string;
  rows: ReadonlyArray<SignInKeyRow>;
  filledId: string | undefined;
  busy: boolean;
  onFill: (accountId: string) => void;
  onReveal: (accountId: string) => Promise<string | undefined>;
  onEdit: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [revealed, setRevealed] = useState<{ accountId: string; password: string } | null>(null);
  // Opening, closing or hiding starts a new generation; a reveal answers only its own.
  const generation = useRef(0);
  const hide = () => {
    generation.current++;
    setRevealed(null);
  };
  const filled = rows.find((row) => row.accountId === filledId);
  const others = rows.filter((row) => row !== filled);
  const shown = filled && revealed?.accountId === filled.accountId ? revealed.password : null;
  return (
    <Popover onOpenChange={hide}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant={filled ? "secondary" : "ghost"}
            aria-label={
              filled
                ? gt("Filled with {account}", { account: rowLabel(filled, messages) })
                : gt("Saved sign-ins for {site}", { site })
            }
          />
        }
      >
        <KeyRoundIcon />
      </PopoverTrigger>
      <PopoverPopup align="end">
        <div className="flex w-72 flex-col gap-3">
          {filled ? (
            <section className="flex flex-col gap-1">
              <PopoverTitle size="compact">
                <T>Filled with</T>
              </PopoverTitle>
              <div className="truncate text-sm">{rowLabel(filled, messages)}</div>
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {shown ?? "••••••••"}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={shown === null ? gt("Show password") : gt("Hide password")}
                  onClick={async () => {
                    if (shown !== null) return hide();
                    const asked = generation.current;
                    const password = await onReveal(filled.accountId);
                    // The shown value is matched to the filled account when it renders.
                    if (password !== undefined && asked === generation.current)
                      setRevealed({ accountId: filled.accountId, password });
                  }}
                >
                  {shown === null ? <EyeIcon /> : <EyeOffIcon />}
                </Button>
              </div>
            </section>
          ) : null}
          {others.length > 0 ? (
            <section className="flex flex-col gap-1">
              <PopoverTitle size="compact">
                {filled ? gt("Other saved sign-ins") : gt("Saved sign-ins for {site}", { site })}
              </PopoverTitle>
              {others.map((row) => (
                <div key={row.accountId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{rowLabel(row, messages)}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    aria-label={gt("Fill {account}", { account: rowLabel(row, messages) })}
                    onClick={() => onFill(row.accountId)}
                  >
                    <T>Fill</T>
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
          <div>
            <Button type="button" size="xs" variant="link" onClick={onEdit}>
              <T>Edit in Accounts</T>
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
