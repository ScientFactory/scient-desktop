import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { Attrs } from "prosemirror-model";

export const referenceAttributes = {
  referenceLabel: { default: null },
  referenceHref: { default: null },
  referenceTitle: { default: null },
} as const;

// Preserve the dependency, not just its resolved URL. Otherwise rewriting a
// block (formatting, a wiki-label edit, etc.) silently detaches reference links.
export function preserveMarkdownReferences(tokenizer: MarkdownIt): void {
  // Use the public ruler API to obtain the stock rules, without copying the
  // Markdown grammar or depending on markdown-it's private rule registry.
  const stock = MarkdownIt("commonmark").inline.ruler;
  for (const name of ["link", "image"] as const) {
    stock.enableOnly([name]);
    const rule = stock.getRules("")[0];
    if (!rule) throw new Error(`Missing Markdown inline rule '${name}'.`);
    tokenizer.inline.ruler.at(name, (state, silent) => {
      if (silent || state.src[state.pos] !== (name === "image" ? "!" : "[")) {
        return rule(state, silent);
      }
      const start = state.pos;
      const bracket = name === "image" ? start + 1 : start;
      const tokenStart = state.tokens.length;
      // Let markdown-it decide which nested/escaped labels are valid.
      const labelEnd =
        state.src[bracket] === "["
          ? state.md.helpers.parseLinkLabel(state, bracket, name === "link")
          : -1;
      if (!rule(state, silent)) return false;
      // Inline destinations end in ')'; all three reference forms end in ']'.
      if (labelEnd >= 0 && state.src[state.pos - 1] === "]") {
        const explicitLabel = state.src.slice(labelEnd + 2, state.pos - 1);
        const label = explicitLabel || state.src.slice(bracket + 1, labelEnd);
        const token = state.tokens
          .slice(tokenStart)
          .find((candidate) => candidate.type === (name === "link" ? "link_open" : "image"));
        token?.attrSet("data-scient-reference-label", label);
      }
      return true;
    });
  }
}

export function parsedReferenceAttributes(token: Token, destination: "href" | "src") {
  const label = token.attrGet("data-scient-reference-label");
  return {
    referenceLabel: label,
    referenceHref: label === null ? null : token.attrGet(destination),
    referenceTitle: label === null ? null : token.attrGet("title") || null,
  };
}

export function retainedReferenceLabel(attrs: Attrs, destination: "href" | "src"): string | null {
  // An explicit destination edit must take precedence over source provenance.
  return typeof attrs.referenceLabel === "string" &&
    attrs[destination] === attrs.referenceHref &&
    (attrs.title ?? null) === attrs.referenceTitle
    ? attrs.referenceLabel
    : null;
}
