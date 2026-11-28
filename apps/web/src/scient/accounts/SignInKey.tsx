import { msg, T, useGT, useMessages } from "gt-react";
import { EyeIcon, EyeOffIcon, KeyRoundIcon, MoreHorizontalIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { m, type MessageResolver } from "~/i18n/messages";
import { formatRelativeTimeLabel } from "~/timestampFormat";

export interface SignInKeyRow {
  readonly accountId: string;
  readonly username: string;
  /** The profile it belongs to, named only where that tells rows apart. */
  readonly profile?: string | undefined;
  /** When its password last worked. */
  readonly workedAt?: string | undefined;
  /** The site refused its password. */
  readonly refused?: boolean | undefined;
}

const rowLabel = (row: SignInKeyRow, resolve: MessageResolver = m) => {
  const username = row.username || resolve(msg("No username"));
  return row.profile ? `${username} · ${row.profile}` : username;
};

/** The last that worked first; a refused one after those, as it is the one least likely to. */
const signInKeyOrder = (rows: ReadonlyArray<SignInKeyRow>) =>
  rows.toSorted(
    (a, b) =>
      Number(Boolean(a.refused)) - Number(Boolean(b.refused)) ||
      (b.workedAt ?? "").localeCompare(a.workedAt ?? ""),
  );

/**
 * The address bar's key, as in Chrome: the saved sign-in Scient filled, and the site's other
 * saved sign-ins to fill instead, each with its own menu. Passwords stay in the app, never the page.
 */
export function SignInKey({
  site,
  rows,
  filledId,
  busy,
  onFill,
  onReveal,
  onCopy,
  onEditRow,
  onRemove,
  onEdit,
}: {
  site: string;
  rows: ReadonlyArray<SignInKeyRow>;
  filledId: string | undefined;
  busy: boolean;
  onFill: (accountId: string) => void;
  /** The person's own Show, recorded as theirs. */
  onReveal: (accountId: string) => Promise<string | undefined>;
  onCopy: (accountId: string) => void;
  /** That login's own editor. */
  onEditRow: (accountId: string) => void;
  /** Removes at once, with Undo; absent where there is no Undo. */
  onRemove?: ((accountId: string) => void) | undefined;
  /** Saved passwords, at this site's logins. */
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
  const show = async (accountId: string) => {
    if (revealed?.accountId === accountId) return hide();
    hide();
    const asked = generation.current;
    const password = await onReveal(accountId);
    if (password !== undefined && asked === generation.current)
      setRevealed({ accountId, password });
  };
  const filled = rows.find((row) => row.accountId === filledId);
  const others = signInKeyOrder(rows.filter((row) => row !== filled));
  const status = (row: SignInKeyRow) =>
    row.refused
      ? gt("Refused")
      : row.workedAt
        ? gt("Worked {time}", { time: formatRelativeTimeLabel(row.workedAt, undefined, messages) })
        : undefined;
  const rowMenu = (row: SignInKeyRow) => (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("More for {account}", { account: rowLabel(row, messages) })}
          />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void show(row.accountId)}>
          {revealed?.accountId === row.accountId ? gt("Hide password") : gt("Show password")}
        </MenuItem>
        <MenuItem onClick={() => onCopy(row.accountId)}>
          <T>Copy password</T>
        </MenuItem>
        <MenuItem onClick={() => onEditRow(row.accountId)}>
          <T>Edit</T>
        </MenuItem>
        {onRemove ? (
          <MenuItem onClick={() => onRemove(row.accountId)}>
            <T>Remove</T>
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
  const shownFor = (row: SignInKeyRow) =>
    revealed?.accountId === row.accountId ? revealed.password : null;
  // The filled login shows its password masked until Show; another, only once shown.
  const line = (row: SignInKeyRow, masked = false) => {
    const text = status(row);
    const password = shownFor(row) ?? (masked ? "••••••••" : null);
    return (
      <>
        {text ? <span className="truncate text-xs text-muted-foreground">{text}</span> : null}
        {password !== null ? <span className="truncate font-mono text-xs">{password}</span> : null}
      </>
    );
  };
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
              <div className="flex items-center gap-1">
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-sm">{rowLabel(filled, messages)}</span>
                  {line(filled, true)}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={shownFor(filled) === null ? gt("Show password") : gt("Hide password")}
                  onClick={() => void show(filled.accountId)}
                >
                  {shownFor(filled) === null ? <EyeIcon /> : <EyeOffIcon />}
                </Button>
                {rowMenu(filled)}
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
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm">{rowLabel(row, messages)}</span>
                    {line(row)}
                  </span>
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
                  {rowMenu(row)}
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
