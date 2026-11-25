import type { ComputeResultCounts } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";

export function PublishedResultText({
  counts,
}: {
  readonly counts?: ComputeResultCounts | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const items =
    counts === undefined
      ? []
      : [
          counts.values > 0
            ? gt("{count, plural, one {# value} other {# values}}", { count: counts.values })
            : null,
          counts.tables > 0
            ? gt("{count, plural, one {# table} other {# tables}}", { count: counts.tables })
            : null,
          counts.figures > 0
            ? gt("{count, plural, one {# figure} other {# figures}}", { count: counts.figures })
            : null,
          counts.files > 0
            ? gt("{count, plural, one {# other file} other {# other files}}", {
                count: counts.files,
              })
            : null,
        ].filter((item) => item !== null);
  return items.length === 0
    ? gt("Results saved.")
    : gt("Saved {items}.", {
        items: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items),
      });
}
