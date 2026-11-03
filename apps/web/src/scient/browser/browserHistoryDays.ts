import type { BrowserHistoryPage } from "@t3tools/contracts";

const DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

function dayLabel(time: number, now: number) {
  const today = startOfDay(now);
  const day = startOfDay(time);
  if (day === today) return "Today";
  if (day === startOfDay(new Date(today).setDate(new Date(today).getDate() - 1))) {
    return "Yesterday";
  }
  return DATE.format(time);
}

/** Newest-first pages, grouped under the day each was last visited. */
export function pagesByDay(pages: ReadonlyArray<BrowserHistoryPage>, now: number) {
  const days: Array<{ label: string; pages: BrowserHistoryPage[] }> = [];
  for (const page of pages) {
    const label = dayLabel(page.lastVisitedAt, now);
    const last = days.at(-1);
    if (last?.label === label) last.pages.push(page);
    else days.push({ label, pages: [page] });
  }
  return days;
}
