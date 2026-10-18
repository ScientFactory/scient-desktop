import type { PagedPlan } from "./latexPagedFlow";
import { latexCounterLabel } from "./latexDocumentStructure";

export function pagedPageNumbering(
  pages: number,
  initial: string,
  controls: readonly { page: number; name: string; value: string }[],
) {
  let start = 0,
    style = initial;
  const numbers: number[] = [];
  const styles = new Map<number, string>();
  const labels = Array.from({ length: pages }, (_, page) => {
    for (const control of controls) {
      if (control.page !== page) continue;
      if (control.name === "pagenumbering") {
        start = page;
        style = control.value;
      }
      if (control.name === "thispagestyle") styles.set(page, control.value);
    }
    const number = page - start + 1;
    numbers.push(number);
    return latexCounterLabel(number, style);
  });
  return { labels, numbers, styles };
}

/** Keep incremental flow checkpoints separate from the physical paper stack. */
export function presentPagedSheets(
  plan: PagedPlan,
  width: number,
  landscape: ReadonlySet<number>,
): PagedPlan {
  const canvas = landscape.size ? Math.max(width, plan.dimensions.height) : width;
  let top = 0;
  const sheets = Array.from({ length: plan.pages }, (_, page) => {
    const rotated = landscape.has(page);
    const sheetWidth = rotated ? plan.dimensions.height : width;
    const height = rotated ? width : plan.dimensions.height;
    const sheet = {
      top,
      left: (canvas - sheetWidth) / 2,
      width: sheetWidth,
      height,
      landscape: rotated,
    };
    top += height + plan.dimensions.gap;
    return sheet;
  });
  return {
    ...plan,
    sheets,
    placements: landscape.size
      ? plan.placements.map((part) => {
          const sheet = sheets[part.page]!;
          return {
            ...part,
            top: part.top - part.page * (plan.dimensions.height + plan.dimensions.gap) + sheet.top,
            // Physical orientation must not masquerade as compressed math glue.
            height: part.height,
          };
        })
      : plan.placements,
  };
}

export function pagedSheetTop(plan: PagedPlan, page: number) {
  return plan.sheets?.[page]?.top ?? page * (plan.dimensions.height + plan.dimensions.gap);
}

export function pagedSheetAt(plan: PagedPlan, top: number) {
  if (!plan.sheets)
    return Math.max(
      0,
      Math.min(plan.pages - 1, Math.floor(top / (plan.dimensions.height + plan.dimensions.gap))),
    );
  let low = 0,
    high = plan.sheets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (plan.sheets[middle]!.top <= top) low = middle;
    else high = middle - 1;
  }
  return low;
}
