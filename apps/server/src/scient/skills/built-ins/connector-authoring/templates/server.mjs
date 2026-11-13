// Example connector: search OpenAlex (a free index of scholarly works) and read one work.
// Replace these tools with the ones your connector needs; keep the shape:
// - a few tools shaped like the user's tasks, with plain descriptions and strict inputs;
// - short results with names, not raw API dumps; paging the agent can follow;
// - errors that say what to do next; keys only from the environment; logs to stderr only.

import * as fs from "node:fs";

import { createHttp, readJson } from "./http.mjs";
import { serve, ToolError } from "./mcp.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const API = "https://api.openalex.org";
const API_KEY = process.env.OPENALEX_API_KEY?.trim() ?? ""; // Optional: a free key raises the budget.

// OpenAlex allows 10 requests a second without a key; stay well under it.
const http = createHttp({
  userAgent: `${manifest.name}/${manifest.version} (Scient connector)`,
  minGapMs: 150,
});

async function openalex(path, params, signal) {
  const url = new URL(path, API);
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }
  // The key goes in a header, not the URL, so it never shows up in logs or error messages.
  const headers = API_KEY ? { authorization: `Bearer ${API_KEY}` } : {};
  return readJson(await http(url.toString(), { headers }, { signal }), "OpenAlex");
}

const shortId = (id) => String(id ?? "").replace("https://openalex.org/", "");
const shortDoi = (doi) => (doi ? String(doi).replace(/^https?:\/\/doi\.org\//i, "") : undefined);

/** Drops undefined fields, so results stay short. */
const compact = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const authorLine = (authorships = [], max = 3) => {
  const names = authorships.map((a) => a.author?.display_name).filter(Boolean);
  return names.length > max ? `${names.slice(0, max).join(", ")} et al.` : names.join(", ");
};

/** OpenAlex stores abstracts as {word: [positions]}; put the words back in order. */
const abstractText = (index) => {
  if (!index) return undefined;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(" ");
};

const SORTS = {
  relevance: undefined, // OpenAlex sorts by relevance when there is a search.
  most_cited: "cited_by_count:desc",
  newest: "publication_date:desc",
};

const searchWorks = {
  name: "search_works",
  title: "Search scholarly works",
  description:
    "Search OpenAlex for papers, books and datasets by words in the title, abstract or full " +
    "text. Returns short records (title, authors, year, venue, DOI, citations, free full-text " +
    "link). Use get_work for the abstract and all authors. Results come in pages: pass " +
    "next_page back as page for more.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: 'Words to search for, e.g. "CRISPR base editing".',
      },
      from_year: { type: "integer", minimum: 1000, maximum: 3000, description: "Earliest year." },
      to_year: { type: "integer", minimum: 1000, maximum: 3000, description: "Latest year." },
      open_access_only: {
        type: "boolean",
        default: false,
        description: "Only works with a free full text.",
      },
      sort: { type: "string", enum: Object.keys(SORTS), default: "relevance" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Per page." },
      page: { type: "integer", minimum: 1, default: 1 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      total: { type: "integer", description: "Matching works in OpenAlex." },
      page: { type: "integer" },
      has_more: { type: "boolean" },
      next_page: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            authors: { type: "string" },
            year: { type: "integer" },
            venue: { type: "string" },
            doi: { type: "string" },
            cited_by: { type: "integer" },
            free_full_text: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    required: ["total", "page", "has_more", "results"],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler({ query, from_year, to_year, open_access_only, sort, limit, page }, { signal }) {
    if (from_year && to_year && from_year > to_year) {
      throw new ToolError("from_year is after to_year. Swap them or drop one.");
    }
    if (page * limit > 10_000) {
      throw new ToolError(
        "OpenAlex pages through the first 10,000 results only. Narrow the search (years, " +
          "open_access_only, more specific words) instead of paging further.",
      );
    }
    const filters = [
      from_year && `from_publication_date:${from_year}-01-01`,
      to_year && `to_publication_date:${to_year}-12-31`,
      open_access_only && "is_oa:true",
    ].filter(Boolean);
    const data = await openalex(
      "/works",
      {
        search: query,
        filter: filters.join(","),
        sort: SORTS[sort],
        per_page: limit,
        page,
        select:
          "id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,open_access",
      },
      signal,
    );
    const total = data.meta?.count ?? 0;
    const hasMore = page * limit < Math.min(total, 10_000);
    return compact({
      total,
      page,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : undefined,
      results: (data.results ?? []).map((work) =>
        compact({
          id: shortId(work.id),
          title: work.display_name ?? undefined,
          authors: authorLine(work.authorships) || undefined,
          year: work.publication_year ?? undefined,
          venue: work.primary_location?.source?.display_name ?? undefined,
          doi: shortDoi(work.doi),
          cited_by: work.cited_by_count ?? undefined,
          free_full_text: work.open_access?.oa_url ?? undefined,
        }),
      ),
    });
  },
};

/** Accepts an OpenAlex id (W123…), an openalex.org URL, a DOI or a doi.org URL. */
function workPath(id) {
  const value = id.trim();
  const openalex = /^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i.exec(value);
  if (openalex) return `/works/${openalex[1].toUpperCase()}`;
  const doi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/\S+)$/i.exec(value);
  if (doi) return `/works/doi:${doi[1].replace(/[?#%]/g, encodeURIComponent)}`;
  throw new ToolError(
    `"${value}" is not an OpenAlex id or a DOI. Use an id like W2741809807 or a DOI like ` +
      "10.1038/nature12373 (search_works finds both).",
  );
}

const getWork = {
  name: "get_work",
  title: "Read one work",
  description:
    "Get one work from OpenAlex by OpenAlex id (W…) or DOI: title, all authors with their " +
    "institutions, year, venue, abstract, topic, citation counts and free full-text link.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        minLength: 2,
        maxLength: 300,
        description: "An OpenAlex id like W2741809807, or a DOI like 10.1038/nature12373.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler({ id }, { signal }) {
    let work;
    try {
      work = await openalex(
        workPath(id),
        {
          select:
            "id,doi,display_name,publication_year,publication_date,type,authorships," +
            "primary_location,primary_topic,abstract_inverted_index,cited_by_count," +
            "referenced_works_count,open_access",
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ToolError && /\(404\)/.test(error.message)) {
        throw new ToolError(
          `OpenAlex has no work "${id}". Check it, or find it with search_works.`,
        );
      }
      throw error;
    }
    const authors = (work.authorships ?? []).map((a) =>
      compact({
        name: a.author?.display_name ?? undefined,
        institutions:
          (a.institutions ?? [])
            .map((i) => i.display_name)
            .filter(Boolean)
            .join("; ") || undefined,
      }),
    );
    const abstract = abstractText(work.abstract_inverted_index);
    return compact({
      id: shortId(work.id),
      title: work.display_name ?? undefined,
      type: work.type ?? undefined,
      year: work.publication_year ?? undefined,
      date: work.publication_date ?? undefined,
      venue: work.primary_location?.source?.display_name ?? undefined,
      doi: shortDoi(work.doi),
      authors: authors.slice(0, 25),
      more_authors: authors.length > 25 ? authors.length - 25 : undefined,
      topic: work.primary_topic?.display_name ?? undefined,
      abstract:
        abstract && abstract.length > 4000
          ? `${abstract.slice(0, 4000)}… [abstract cut]`
          : abstract,
      cited_by: work.cited_by_count ?? undefined,
      references: work.referenced_works_count ?? undefined,
      free_full_text: work.open_access?.oa_url ?? undefined,
      landing_page: work.primary_location?.landing_page_url ?? undefined,
    });
  },
};

serve({
  name: manifest.name,
  version: manifest.version,
  title: manifest.display_name,
  instructions:
    "Search with search_works, then read a work with get_work. Results are short on purpose; " +
    "ask for more pages only when the user needs them.",
  tools: [searchWorks, getWork],
});
