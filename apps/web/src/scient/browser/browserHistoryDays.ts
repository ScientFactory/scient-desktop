import type { BrowserHistoryPage } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

function dayLabel(time: number, now: number, resolve: MessageResolver) {
  const today = startOfDay(now);
  const day = startOfDay(time);
  if (day === today) return resolve(msg("Today"));
  if (day === startOfDay(new Date(today).setDate(new Date(today).getDate() - 1))) {
    return resolve(msg("Yesterday"));
  }
  return DATE.format(time);
}

/** Newest-first pages, grouped under the day each was last visited. */
export function pagesByDay(
  pages: ReadonlyArray<BrowserHistoryPage>,
  now: number,
  resolve: MessageResolver = m,
) {
  const days: Array<{ label: string; pages: BrowserHistoryPage[] }> = [];
  for (const page of pages) {
    const label = dayLabel(page.lastVisitedAt, now, resolve);
    const last = days.at(-1);
    if (last?.label === label) last.pages.push(page);
    else days.push({ label, pages: [page] });
  }
  return days;
}
