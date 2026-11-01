import { isExtensionIconDataUri, type ExtensionIconDataUri } from "@t3tools/contracts";
import { normalizeBrandIconName } from "./BrandIconNames.ts";
import aliases from "./brandIcons/aliases.json" with { type: "json" };
import icons from "./brandIcons/brandIcons.json" with { type: "json" };
import curated from "./discover/curatedIcons.json" with { type: "json" };

const images: Readonly<Record<string, string>> = { ...curated, ...icons };
const names = new Map(Object.entries(aliases));

export function resolveBrandIcon(name: string): ExtensionIconDataUri | undefined {
  const key = names.get(normalizeBrandIconName(name));
  const icon = key === undefined ? undefined : images[key];
  return isExtensionIconDataUri(icon) ? icon : undefined;
}
