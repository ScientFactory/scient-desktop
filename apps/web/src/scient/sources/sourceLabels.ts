function isSameCalendarDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function sourceAddedLabel(
  importedAt: string,
  recentlyAdded: boolean,
  addedByAgent = false,
): string {
  if (recentlyAdded) return addedByAgent ? "Just added by an agent" : "Just added";
  const date = new Date(importedAt);
  if (Number.isNaN(date.getTime())) return "Added to Scient";
  if (isSameCalendarDay(date, new Date())) return "Added today";
  return `Added ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)}`;
}
