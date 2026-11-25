import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const parse = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const thisYearFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A date as a person reads it ("Nov 25, 2026"); text that is not a date is shown as it is. */
export function dayLabel(iso: string): string {
  const date = parse(iso);
  return date ? dayFormat.format(date) : iso;
}

const calendarDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

/**
 * When something happened, in the one style every Library list uses: "Today, 9:31 PM",
 * "Yesterday, 9:31 PM", "Nov 25, 9:31 PM", and "Nov 25, 2025" in an earlier year.
 */
export function whenLabel(iso: string, resolve: MessageResolver = m, now = new Date()): string {
  const date = parse(iso);
  if (!date) return "";
  const daysAgo = calendarDay(now) - calendarDay(date);
  const time = timeFormat.format(date);
  if (daysAgo === 0) return resolve(msg("Today, {time}", { time }));
  if (daysAgo === 1) return resolve(msg("Yesterday, {time}", { time }));
  return date.getFullYear() === now.getFullYear()
    ? thisYearFormat.format(date)
    : dayFormat.format(date);
}

/** Who did it and when, for a list row: the person's own changes show only the time. */
export function byLine(
  by: "user" | "agent",
  iso: string,
  resolve: MessageResolver = m,
  now = new Date(),
): string {
  const when = whenLabel(iso, resolve, now);
  if (by === "user") return when;
  return when ? resolve(msg("Agent · {when}", { when })) : resolve(msg("Agent"));
}
