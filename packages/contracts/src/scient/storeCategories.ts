import type { ExtensionCategory } from "./extensions.ts";

const STORE_CATEGORIES: Readonly<Record<string, readonly ExtensionCategory[]>> = {
  "education & research": ["papers"],
  research: ["papers"],
  learning: ["papers"],
  "data & analytics": ["data"],
  database: ["data"],
  "developer tools": ["code"],
  coding: ["code"],
  development: ["code"],
  security: ["code"],
  monitoring: ["code"],
  productivity: ["files", "projects"],
  communication: ["communication"],
  creativity: ["figures"],
  design: ["figures"],
  math: ["physics-math"],
  location: ["earth"],
  "business & operations": ["projects"],
};
const OVERRIDES: Readonly<Record<string, readonly ExtensionCategory[]>> = {
  zotero: ["papers"],
  "life-science-research": ["biology"],
  "ngs-analysis": ["biology"],
  "boltz-api-cli": ["chemistry", "biology"],
  scite: ["papers"],
  readwise: ["papers"],
  deepnote: ["data"],
  hex: ["data"],
  motherduck: ["data"],
  "math-olympiad": ["physics-math"],
  "math-proof": ["physics-math"],
  "10x-genomics": ["biology"],
  skywatch: ["earth"],
  dominodatalab: ["data"],
  "neon-postgres": ["data", "code"],
  supabase: ["data", "code"],
  biorender: ["biology", "figures"],
};

export function storeCategories(
  name: string,
  category: string | undefined,
): readonly ExtensionCategory[] {
  return (
    OVERRIDES[name.toLowerCase()] ?? STORE_CATEGORIES[category?.trim().toLowerCase() ?? ""] ?? []
  );
}
