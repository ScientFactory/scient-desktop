import { EyeIcon, EyeOffIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";

export interface SignInKeyRow {
  readonly accountId: string;
  readonly username: string;
  /** The profile it belongs to, named only where that tells rows apart. */
  readonly profile?: string | undefined;
}

const rowLabel = (row: SignInKeyRow) =>
  row.profile ? `${row.username || "No username"} · ${row.profile}` : row.username || "No username";

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
  const [revealed, setRevealed] = useState<{ accountId: string; password: string } | null>(null);
  const filled = rows.find((row) => row.accountId === filledId);
  const others = rows.filter((row) => row !== filled);
  const shown = filled && revealed?.accountId === filled.accountId ? revealed.password : null;
  return (
    <Popover onOpenChange={(open) => !open && setRevealed(null)}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant={filled ? "secondary" : "ghost"}
            aria-label={filled ? `Filled with ${rowLabel(filled)}` : `Saved sign-ins for ${site}`}
          />
        }
      >
        <KeyRoundIcon />
      </PopoverTrigger>
      <PopoverPopup align="end">
        <div className="flex w-72 flex-col gap-3">
          {filled ? (
            <section className="flex flex-col gap-1">
              <PopoverTitle size="compact">Filled with</PopoverTitle>
              <div className="truncate text-sm">{rowLabel(filled)}</div>
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {shown ?? "••••••••"}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={shown === null ? "Show password" : "Hide password"}
                  onClick={async () => {
                    if (shown !== null) return setRevealed(null);
                    const password = await onReveal(filled.accountId);
                    if (password !== undefined)
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
                {filled ? "Other saved sign-ins" : `Saved sign-ins for ${site}`}
              </PopoverTitle>
              {others.map((row) => (
                <div key={row.accountId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{rowLabel(row)}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    aria-label={`Fill ${rowLabel(row)}`}
                    onClick={() => onFill(row.accountId)}
                  >
                    Fill
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
          <div>
            <Button type="button" size="xs" variant="link" onClick={onEdit}>
              Edit in Accounts
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
