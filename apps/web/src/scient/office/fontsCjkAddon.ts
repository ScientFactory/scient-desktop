// `@betteroffice/fonts` imports its optional CJK add-on for the URLs of the raw OTF faces. The app aliases the add-on
// here (`scripts/scientCjkFonts.ts`) so those files are never bundled; `cjkFonts.ts` loads their compressed copies.
export const CJK_FONT_ASSET_URLS: Record<string, () => URL> = {};
