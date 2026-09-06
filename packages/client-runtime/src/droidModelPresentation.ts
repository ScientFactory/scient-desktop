type DroidModelRow = {
  readonly slug: string;
  readonly name: string;
  readonly isLegacy?: boolean | undefined;
};

// Presentation only: never filter discovery or change availability. Unknown/new
// model families remain visible until deliberately curated.
const OLDER_CLAUDE = /^claude-(?:opus-4-(?:5|6)|sonnet-4-5)(?:-|$)/;
const ADDITIONAL_MODELS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-4-8-fast",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "kimi-k2.6",
  "grok-4.5",
]);

export function getDroidModelSection(model: DroidModelRow): "models" | "custom" | "more" {
  // Native and Scient BYOK share Droid's stable custom: namespace. This is not
  // the legacy isCustom flag (which controls manually authored slug entries).
  if (model.slug.startsWith("custom:")) return "custom";
  if (
    ADDITIONAL_MODELS.has(model.slug) ||
    model.isLegacy ||
    /\[deprecated\]/i.test(model.name) ||
    OLDER_CLAUDE.test(model.slug)
  ) {
    return "more";
  }
  const gpt = /^gpt-(\d+)(?:\.(\d+))?o?(?:-|$)/.exec(model.slug);
  if (gpt && (Number(gpt[1]) < 5 || (Number(gpt[1]) === 5 && Number(gpt[2] ?? 0) < 6))) {
    return "more";
  }
  return "models";
}

export function groupDroidModelRows<T extends DroidModelRow>(
  rows: ReadonlyArray<T>,
): { models: T[]; custom: T[]; more: T[] } {
  const groups: { models: T[]; custom: T[]; more: T[] } = { models: [], custom: [], more: [] };
  for (const row of rows) {
    const section = getDroidModelSection(row);
    groups[section].push(row);
  }
  return groups;
}
