import { msg } from "gt-react";

export type ExpiryChoice = "never" | "day" | "week" | "month";

const DAY_MS = 24 * 60 * 60 * 1000;

export const EXPIRY_CHOICES: ReadonlyArray<{
  readonly id: ExpiryChoice;
  /** A `msg()` label, resolved where it is shown. */
  readonly label: string;
  readonly ms: number | null;
}> = [
  { id: "never", label: msg("Never expires"), ms: null },
  { id: "day", label: msg("Expires in a day"), ms: DAY_MS },
  { id: "week", label: msg("Expires in a week"), ms: 7 * DAY_MS },
  { id: "month", label: msg("Expires in 30 days"), ms: 30 * DAY_MS },
];

export function expiresAtFor(choice: ExpiryChoice, now = Date.now()): string | null {
  const ms = EXPIRY_CHOICES.find((entry) => entry.id === choice)?.ms ?? null;
  return ms === null ? null : new Date(now + ms).toISOString();
}

/** The closest choice for an existing expiry, so the picker shows something true. */
export function expiryChoice(expiresAt: string | null, now = Date.now()): ExpiryChoice {
  if (expiresAt === null) return "never";
  const left = Date.parse(expiresAt) - now;
  if (left <= DAY_MS) return "day";
  if (left <= 7 * DAY_MS) return "week";
  return "month";
}
