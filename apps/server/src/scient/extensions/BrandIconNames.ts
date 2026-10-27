export function normalizeBrandIconName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^claude\.ai\s+/, "")
    .replace(/@[^@]*$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
