import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

/**
 * Which templates a new document offers on its page and which behind "More",
 * in the person's order, and which they have hidden. Kept on this device,
 * beside the default template.
 */
export interface TemplateLayout {
  readonly page: readonly string[];
  readonly more: readonly string[];
  readonly hidden: readonly string[];
}

export const TEMPLATE_LAYOUT_STORAGE_KEY = "scient.documentTemplateLayout";

/** The most the page row holds, so it stays one quiet line. */
export const TEMPLATE_PAGE_LIMIT = 5;

/** How many templates the page row offers before anyone arranges it. */
const DEFAULT_PAGE_COUNT = 4;

const StoredTemplateLayout = Schema.NullOr(
  Schema.Struct({
    page: Schema.Array(Schema.String),
    more: Schema.Array(Schema.String),
    hidden: Schema.Array(Schema.String),
  }),
);

export function defaultTemplateLayout(templates: readonly string[]): TemplateLayout {
  return {
    page: templates.slice(0, DEFAULT_PAGE_COUNT),
    more: templates.slice(DEFAULT_PAGE_COUNT),
    hidden: [],
  };
}

/**
 * A stored layout made whole for today's templates: names that no longer exist
 * drop out, each template appears once, and any template the layout does not
 * know yet (a new one) joins the end of More.
 */
export function resolveTemplateLayout(
  stored: TemplateLayout | null,
  templates: readonly string[],
): TemplateLayout {
  if (stored === null) return defaultTemplateLayout(templates);
  const known = new Set(templates);
  const seen = new Set<string>();
  const keep = (ids: readonly string[]) => {
    const kept: string[] = [];
    for (const id of ids) {
      if (!known.has(id) || seen.has(id)) continue;
      seen.add(id);
      kept.push(id);
    }
    return kept;
  };
  const page = keep(stored.page).slice(0, TEMPLATE_PAGE_LIMIT);
  const hidden = keep(stored.hidden);
  const more = keep([...stored.page.slice(TEMPLATE_PAGE_LIMIT), ...stored.more]);
  for (const id of templates) if (!seen.has(id)) more.push(id);
  return { page, more, hidden };
}

export function sameTemplateLayout(a: TemplateLayout, b: TemplateLayout): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((id, index) => id === y[index]);
  return same(a.page, b.page) && same(a.more, b.more) && same(a.hidden, b.hidden);
}

function without(layout: TemplateLayout, id: string): TemplateLayout {
  return {
    page: layout.page.filter((entry) => entry !== id),
    more: layout.more.filter((entry) => entry !== id),
    hidden: layout.hidden.filter((entry) => entry !== id),
  };
}

/**
 * Onto the page row, at its end. A full row makes room by sending its last
 * template to the top of More.
 */
export function moveTemplateToPage(layout: TemplateLayout, id: string): TemplateLayout {
  const rest = without(layout, id);
  if (rest.page.length < TEMPLATE_PAGE_LIMIT) return { ...rest, page: [...rest.page, id] };
  const replaced = rest.page.at(-1)!;
  return {
    ...rest,
    page: [...rest.page.slice(0, -1), id],
    more: [replaced, ...rest.more],
  };
}

/** Behind "More", at its top. */
export function moveTemplateToMore(layout: TemplateLayout, id: string): TemplateLayout {
  const rest = without(layout, id);
  return { ...rest, more: [id, ...rest.more] };
}

/** Out of sight, until defaults are restored. */
export function hideTemplate(layout: TemplateLayout, id: string): TemplateLayout {
  const rest = without(layout, id);
  return { ...rest, hidden: [...rest.hidden, id] };
}

/** One template moved to another's place within the page row or within More. */
export function reorderTemplates(
  layout: TemplateLayout,
  list: "page" | "more",
  id: string,
  over: string,
): TemplateLayout {
  const ids = [...layout[list]];
  const from = ids.indexOf(id);
  const to = ids.indexOf(over);
  if (from < 0 || to < 0 || from === to) return layout;
  ids.splice(to, 0, ...ids.splice(from, 1));
  return { ...layout, [list]: ids };
}

/** What a template's menu offers. */
export type TemplateAction = "default" | "page" | "more" | "hide";

/** The menu for one template: its labels, in order, for where it is now. */
export function templateActions(
  layout: TemplateLayout,
  id: string,
  defaultTemplate: string,
): readonly { readonly id: TemplateAction; readonly label: string; readonly disabled?: true }[] {
  return [
    defaultTemplate === id
      ? { id: "default", label: "Default", disabled: true }
      : { id: "default", label: "Set as default" },
    layout.page.includes(id)
      ? { id: "more", label: "Move to More" }
      : { id: "page", label: "Move to page" },
    { id: "hide", label: "Hide" },
  ];
}

/** A layout change a template's menu asks for; "default" changes no layout. */
export function applyTemplateAction(
  layout: TemplateLayout,
  action: Exclude<TemplateAction, "default">,
  id: string,
): TemplateLayout {
  if (action === "page") return moveTemplateToPage(layout, id);
  if (action === "more") return moveTemplateToMore(layout, id);
  return hideTemplate(layout, id);
}

/** The layout new documents use, with the means to change it. */
export function useTemplateLayout(templates: readonly string[]) {
  const [stored, setStored] = useLocalStorage(
    TEMPLATE_LAYOUT_STORAGE_KEY,
    null,
    StoredTemplateLayout,
  );
  const layout = resolveTemplateLayout(stored, templates);
  const isDefault = sameTemplateLayout(layout, defaultTemplateLayout(templates));
  return {
    layout,
    isDefault,
    update: (change: (layout: TemplateLayout) => TemplateLayout) =>
      setStored(change(resolveTemplateLayout(stored, templates))),
    restoreDefaults: () => setStored(null),
  };
}
