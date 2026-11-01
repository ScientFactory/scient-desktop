/**
 * Re-verify MCP initialization and registry identity before changing curated entries. Bundle
 * official icons rather than fetching at runtime; they identify third-party services without
 * affiliation or endorsement.
 */
import {
  matchesExtensionAddressTemplate,
  type DiscoverEntry,
  type ExtensionCategory,
} from "@t3tools/contracts";

import CURATED_ICONS from "./curatedIcons.json" with { type: "json" };

const CATALOG_VERIFIED_ON = "2026-10-21";

/** Names of curated servers not listed in the MCP Registry. Install them by URL. */
export const CURATED_NAME_PREFIX = "scient.curated/";

/** Section order on the Discover home page. */
export const FEATURED_SERVER_IDS = [
  "semantic-scholar",
  "pubmed",
  "wolfram",
  "hugging-face",
  "nasa-earthdata",
  "biorender",
] as const;

export const CATALOG_CATEGORY_ORDER: ReadonlyArray<ExtensionCategory> = [
  "featured",
  "papers",
  "biology",
  "chemistry",
  "earth",
  "physics-math",
  "social-science",
  "data",
  "writing",
  "figures",
  "code",
  "teamwork",
];

export const CATALOG_SECTIONS: Readonly<
  Record<ExtensionCategory, { readonly title: string; readonly description: string }>
> = {
  featured: { title: "Featured", description: "Strong starting points across the sciences." },
  papers: {
    title: "Papers & evidence",
    description: "Find publications, follow citations and weigh the evidence.",
  },
  biology: {
    title: "Biology & health",
    description: "Genes, proteins, structures, disease, trials and lab data.",
  },
  chemistry: {
    title: "Chemistry & materials",
    description: "Compounds, properties, bioactivity and materials.",
  },
  earth: {
    title: "Earth & environment",
    description: "Earth observation, climate, earthquakes, biodiversity and agriculture.",
  },
  "physics-math": {
    title: "Physics, astronomy & math",
    description: "Preprints, symbolic computation, sequences and the sky.",
  },
  "social-science": {
    title: "Social science & economics",
    description: "Economic and development indicators, census data and open studies.",
  },
  data: {
    title: "Data & statistics",
    description: "Datasets, notebooks and databases.",
  },
  writing: {
    title: "Writing & references",
    description: "Documents, notes, files and references.",
  },
  figures: {
    title: "Figures & presentations",
    description: "Scientific illustrations, diagrams, slides and boards.",
  },
  code: { title: "Code", description: "Repositories, documentation and developer tools." },
  teamwork: { title: "Teamwork", description: "Chat, meetings, tasks and project tracking." },
};

export interface CuratedServer {
  /** Stable slug; the entry name when the server is not in the registry. */
  readonly id: string;
  readonly displayName: string;
  /** Plain text, at most 60 characters. */
  readonly tagline: string;
  /** Two or three sentences. */
  readonly description: string;
  /** Streamable HTTP endpoint (https). */
  readonly url: string;
  /** The MCP Registry entry publishing this exact remote, when there is one. */
  readonly registry?: { readonly name: string; readonly version: string };
  /** First category is the primary one; `featured` may be added to any entry. */
  readonly categories: ReadonlyArray<ExtensionCategory>;
  readonly websiteUrl: string;
  /** Bundled logo: a `data:` URI that passes `isExtensionIconDataUri`. */
  readonly icon: string;
  readonly agentStores?: DiscoverEntry["agentStores"];
  readonly accountRequired?: boolean;
  readonly oauthClientRequired?: boolean;
  readonly hosting?: string;
  readonly paidPlan?: boolean;
  readonly beta?: boolean;
  readonly accessNote?: string;
  readonly apiKey?: DiscoverEntry["apiKey"];
  readonly address?: DiscoverEntry["address"];
}

export const CURATED_SERVERS: ReadonlyArray<CuratedServer> = [
  // ── Research ────────────────────────────────────────────────────────────
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (7 tools).
    id: "pubmed",
    accountRequired: false,
    displayName: "PubMed",
    tagline: "Biomedical papers, abstracts and full text",
    description:
      "Search biomedical literature, read abstracts and find related papers. Anthropic's public connector also retrieves full text from PubMed Central when available; article reuse follows the publisher's licence.",
    url: "https://pubmed.mcp.claude.com/mcp",
    categories: ["featured", "papers", "biology"],
    websiteUrl: "https://pubmed.ncbi.nlm.nih.gov",
    icon: CURATED_ICONS["pubmed"],
  },
  {
    // open: 200 "Asta Scientific Corpus Tool" 1.9.4
    id: "semantic-scholar",
    accountRequired: false,
    displayName: "Semantic Scholar",
    tagline: "Search papers, authors and citations",
    description:
      "Ai2's Semantic Scholar corpus for agents. Search papers by relevance or title, read citations and author publication lists, and pull matching snippets from paper text.",
    url: "https://api.semanticscholar.org/mcp",
    categories: ["featured", "papers"],
    websiteUrl: "https://www.semanticscholar.org",
    icon: CURATED_ICONS["semantic-scholar"],
  },
  {
    // sign-in: 401 OAuth (free OpenAlex account)
    id: "openalex",
    accountRequired: true,
    displayName: "OpenAlex",
    tagline: "Open catalog of scholarly works and authors",
    description:
      "Query OpenAlex, the open index of research papers, authors, institutions and citations. Useful for literature mapping and bibliometrics; sign in with a free OpenAlex account.",
    url: "https://mcp.openalex.org/mcp",
    registry: { name: "org.openalex/openalex", version: "0.5.0" },
    categories: ["papers", "data"],
    websiteUrl: "https://openalex.org",
    icon: CURATED_ICONS["openalex"],
  },
  {
    // sign-in: 401 OAuth
    id: "scholar-gateway",
    accountRequired: true,
    displayName: "Scholar Gateway",
    tagline: "Peer-reviewed research from Wiley",
    description:
      "Wiley's gateway to peer-reviewed literature for AI assistants. Search scholarly content and get answers grounded in citable sources.",
    url: "https://connector.scholargateway.ai/mcp",
    categories: ["papers"],
    websiteUrl: "https://scholargateway.ai",
    icon: CURATED_ICONS["scholar-gateway"],
  },
  {
    // sign-in: 401 OAuth (scope "search")
    id: "consensus",
    accountRequired: true,
    displayName: "Consensus",
    tagline: "Evidence from peer-reviewed studies",
    description:
      "Search peer-reviewed research and see what studies conclude about a question. Results link back to the underlying papers.",
    url: "https://mcp.consensus.app/mcp",
    categories: ["papers"],
    websiteUrl: "https://consensus.app",
    icon: CURATED_ICONS["consensus"],
  },
  {
    // sign-in: 401 OAuth
    id: "scite",
    accountRequired: true,
    displayName: "scite",
    tagline: "See how papers are cited",
    description:
      "Find papers and see whether later work supports or contrasts their claims. Uses scite's Smart Citations index; sign in with a scite account.",
    url: "https://api.scite.ai/mcp",
    registry: { name: "ai.scite/mcp", version: "1.0.0" },
    categories: ["papers", "writing"],
    websiteUrl: "https://scite.ai",
    icon: CURATED_ICONS["scite"],
  },
  {
    // sign-in: 401 OAuth
    id: "synapse",
    accountRequired: true,
    displayName: "Synapse",
    tagline: "Biomedical research data from Sage Bionetworks",
    description:
      "Find and read projects, files and metadata on Synapse, Sage Bionetworks' platform for sharing biomedical research data. Access follows your Synapse permissions.",
    url: "https://mcp.synapse.org/mcp",
    categories: ["biology", "data"],
    websiteUrl: "https://www.synapse.org",
    icon: CURATED_ICONS["synapse"],
  },
  {
    // open: 200 "huggingface.co/mcp" 0.4.31
    id: "hugging-face",
    accountRequired: false,
    displayName: "Hugging Face",
    tagline: "Models, datasets, Spaces and papers on the Hub",
    description:
      "Search the Hugging Face Hub for models, datasets, Spaces and papers, and read repository details and files. Works without an account; sign in to reach your private repositories.",
    url: "https://huggingface.co/mcp",
    registry: { name: "co.huggingface/hf-mcp-server", version: "0.2.33" },
    categories: ["featured", "data", "code"],
    websiteUrl: "https://huggingface.co",
    icon: CURATED_ICONS["hugging-face"],
  },
  {
    // open: 200 "Kaggle.Web" 1.0.0.0
    id: "kaggle",
    accountRequired: false,
    displayName: "Kaggle",
    tagline: "Datasets, notebooks and competitions",
    description:
      "Search and download Kaggle datasets, explore competitions and leaderboards, and work with notebooks and models. Some actions need a signed-in Kaggle account.",
    url: "https://www.kaggle.com/mcp",
    categories: ["data"],
    websiteUrl: "https://www.kaggle.com",
    icon: CURATED_ICONS["kaggle"],
  },

  // ── Biology & genetics ──────────────────────────────────────────────────
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (7 tools).
    id: "biorxiv",
    accountRequired: false,
    displayName: "bioRxiv & medRxiv",
    tagline: "Biology and medicine before peer review",
    description:
      "Find preprints by topic, date or funder and follow their published versions. Anthropic's public connector searches both bioRxiv and medRxiv; these manuscripts have not yet been peer reviewed.",
    url: "https://hcls.mcp.claude.com/biorxiv/mcp",
    categories: ["papers", "biology"],
    websiteUrl: "https://www.biorxiv.org",
    icon: CURATED_ICONS["biorxiv"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (6 tools).
    id: "clinical-trials",
    accountRequired: false,
    displayName: "ClinicalTrials.gov",
    tagline: "Find studies, eligibility rules and trial results",
    description:
      "Search registered clinical studies by condition, sponsor or eligibility and read their endpoints and results. Uses Anthropic's public connector to ClinicalTrials.gov; no account needed.",
    url: "https://hcls.mcp.claude.com/clinical_trials/mcp",
    categories: ["biology", "papers"],
    websiteUrl: "https://clinicaltrials.gov",
    icon: CURATED_ICONS["clinical-trials"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (6 tools).
    id: "chembl",
    accountRequired: false,
    displayName: "ChEMBL",
    tagline: "Compounds, drug targets and measured activity",
    description:
      "Find bioactive compounds, protein targets and experimental activity measurements in EMBL-EBI's ChEMBL database. Anthropic's public connector also looks up drug mechanisms and molecular properties.",
    url: "https://hcls.mcp.claude.com/chembl/mcp",
    categories: ["chemistry", "biology"],
    websiteUrl: "https://www.ebi.ac.uk/chembl",
    icon: CURATED_ICONS["chembl"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (7 tools); exact registry remote.
    id: "ensembl-community",
    accountRequired: false,
    displayName: "Ensembl (community)",
    tagline: "Genes, sequences, variants and related species",
    description:
      "Look up genes, retrieve DNA or protein sequences, predict variant consequences and find related genes across species. Community server maintained and hosted by Casey Hand, using the Ensembl REST API; no account needed.",
    url: "https://ensembl.caseyjhand.com/mcp",
    registry: { name: "io.github.cyanheads/ensembl-mcp-server", version: "0.6.2" },
    categories: ["biology"],
    websiteUrl: "https://github.com/cyanheads/ensembl-mcp-server",
    icon: CURATED_ICONS["ensembl-community"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (6 tools); exact registry remote.
    id: "uniprot-community",
    accountRequired: false,
    displayName: "UniProt (community)",
    tagline: "Protein functions, sequences and database IDs",
    description:
      "Search UniProtKB for proteins, read curated records, retrieve sequences and translate identifiers between biological databases. Community server maintained and hosted by Casey Hand, using UniProt's public API; no account needed.",
    url: "https://uniprot.caseyjhand.com/mcp",
    registry: { name: "io.github.cyanheads/uniprot-mcp-server", version: "0.3.0" },
    categories: ["biology"],
    websiteUrl: "https://github.com/cyanheads/uniprot-mcp-server",
    icon: CURATED_ICONS["uniprot-community"],
  },
  {
    // open: 200 Open Targets Platform 2026.7.1
    id: "open-targets",
    accountRequired: false,
    displayName: "Open Targets",
    tagline: "Target–disease evidence for drug discovery",
    description:
      "Query the Open Targets Platform for targets, diseases, drugs and the evidence linking them. Agents can search entities and run GraphQL queries against the platform.",
    url: "https://mcp.platform.opentargets.org/mcp",
    categories: ["biology", "chemistry"],
    websiteUrl: "https://platform.opentargets.org",
    icon: CURATED_ICONS["open-targets"],
  },

  // ── Math & computer science ─────────────────────────────────────────────
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (3 tools); exact registry remote.
    id: "wolfram",
    accountRequired: false,
    displayName: "Wolfram",
    tagline: "Compute integrals, solve equations and explore data",
    description:
      "Compute symbolic and numerical answers, evaluate Wolfram Language and query curated data through Wolfram Research's official server. Free without an account for limited personal, small-scale use; requests are stateless. Wolfram's terms restrict bulk extraction and AI training; other uses may require separate licensing.",
    url: "https://agenttools.wolfram.com/mcp",
    registry: { name: "com.wolfram/mcp", version: "1.0.1" },
    categories: ["featured", "physics-math", "data"],
    websiteUrl: "https://www.wolfram.com/ai/mcp/cloud/",
    icon: CURATED_ICONS["wolfram"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (4 tools); exact registry remote.
    id: "arxiv-community",
    accountRequired: false,
    displayName: "arXiv (community)",
    tagline: "Find and read mathematics and computer science papers",
    description:
      "Search arXiv preprints by topic, author or category, retrieve paper metadata and read available full text. Community server maintained and hosted by Casey Hand; no account needed. Preprints may not be peer reviewed, and reuse follows each paper's licence.",
    url: "https://arxiv.caseyjhand.com/mcp",
    registry: { name: "io.github.cyanheads/arxiv-mcp-server", version: "1.8.0" },
    categories: ["papers", "physics-math"],
    websiteUrl: "https://github.com/cyanheads/arxiv-mcp-server",
    icon: CURATED_ICONS["arxiv-community"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (6 tools); exact registry remote.
    id: "oeis-community",
    accountRequired: false,
    displayName: "OEIS (community)",
    tagline: "Identify integer sequences and find formulas and programs",
    description:
      "Identify sequences from their terms and explore formulas, programs, extended terms and related entries in the On-Line Encyclopedia of Integer Sequences. Community server maintained and hosted by Casey Hand; uncached lookups share one request every 10 seconds. OEIS data is CC BY-SA 4.0: credit OEIS with a link and share adaptations under the same licence.",
    url: "https://oeis.caseyjhand.com/mcp",
    registry: { name: "io.github.cyanheads/oeis-mcp-server", version: "0.1.3" },
    categories: ["physics-math"],
    websiteUrl: "https://github.com/cyanheads/oeis-mcp-server",
    icon: CURATED_ICONS["oeis-community"],
  },

  // ── Data ────────────────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "hex",
    accountRequired: true,
    displayName: "Hex",
    tagline: "Notebooks and data apps in Hex",
    description:
      "Work with your Hex workspace: find projects, run analyses and read results. Access follows your Hex permissions.",
    url: "https://app.hex.tech/mcp",
    categories: ["data"],
    websiteUrl: "https://hex.tech",
    icon: CURATED_ICONS["hex"],
  },
  {
    // sign-in: 401 OAuth
    id: "motherduck",
    accountRequired: true,
    displayName: "MotherDuck",
    tagline: "Query DuckDB databases in the cloud",
    description:
      "Explore schemas and run SQL against your MotherDuck databases. Good for analysing tabular research data without moving it.",
    url: "https://api.motherduck.com/mcp",
    categories: ["data"],
    websiteUrl: "https://motherduck.com",
    icon: CURATED_ICONS["motherduck"],
  },
  {
    // sign-in: 401 OAuth
    id: "supabase",
    accountRequired: true,
    displayName: "Supabase",
    tagline: "Postgres projects, tables and SQL",
    description:
      "Manage Supabase projects: inspect tables, run SQL, apply migrations and read logs. Access follows the organizations you authorize.",
    url: "https://mcp.supabase.com/mcp",
    registry: { name: "com.supabase/mcp", version: "0.14.0" },
    categories: ["data", "code"],
    websiteUrl: "https://supabase.com",
    icon: CURATED_ICONS["supabase"],
  },
  {
    // sign-in: 401 OAuth
    id: "neon",
    accountRequired: true,
    displayName: "Neon",
    tagline: "Serverless Postgres with branching",
    description:
      "Create and manage Neon Postgres projects and branches, and run SQL against them. Branches make it safe to try schema changes.",
    url: "https://mcp.neon.tech/mcp",
    registry: { name: "com.neon/mcp", version: "1.0.0" },
    categories: ["data", "code"],
    websiteUrl: "https://neon.com",
    icon: CURATED_ICONS["neon"],
  },
  {
    // sign-in: 401 OAuth
    id: "airtable",
    accountRequired: true,
    displayName: "Airtable",
    tagline: "Bases, tables and records",
    description:
      "Read and update records in your Airtable bases, and inspect their tables and fields. Handy for lab inventories and study trackers kept in Airtable.",
    url: "https://mcp.airtable.com/mcp",
    registry: { name: "com.airtable/mcp", version: "0.1.0" },
    categories: ["data", "teamwork"],
    websiteUrl: "https://www.airtable.com",
    icon: CURATED_ICONS["airtable"],
  },

  // ── Code ────────────────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "github",
    accountRequired: true,
    agentStores: { codex: "github" },
    displayName: "GitHub",
    tagline: "Repositories, issues and pull requests",
    description:
      "Work with GitHub repositories, issues, pull requests and Actions from your agent. Access follows the account and organizations you authorize.",
    url: "https://api.githubcopilot.com/mcp/",
    registry: { name: "io.github.github/github-mcp-server", version: "2.0.2" },
    categories: ["code"],
    websiteUrl: "https://github.com",
    icon: CURATED_ICONS["github"],
  },
  {
    // open: 200 "DeepWiki" 2.14.3
    id: "deepwiki",
    accountRequired: false,
    displayName: "DeepWiki",
    tagline: "Ask questions about any public GitHub repo",
    description:
      "Read generated documentation for public GitHub repositories and ask questions about how their code works. No account needed.",
    url: "https://mcp.deepwiki.com/mcp",
    categories: ["code"],
    websiteUrl: "https://deepwiki.com",
    icon: CURATED_ICONS["deepwiki"],
  },
  {
    // sign-in: 401 OAuth
    id: "gitlab",
    accountRequired: true,
    displayName: "GitLab",
    tagline: "Projects, issues and merge requests",
    description:
      "Work with GitLab projects, issues and merge requests on gitlab.com. Access follows the account you authorize.",
    url: "https://gitlab.com/api/v4/mcp",
    registry: { name: "com.gitlab/mcp", version: "0.0.1" },
    categories: ["code"],
    websiteUrl: "https://gitlab.com",
    icon: CURATED_ICONS["gitlab"],
  },
  {
    // open: 200 "Context7" 4.4.3
    id: "context7",
    accountRequired: false,
    displayName: "Context7",
    tagline: "Up-to-date library documentation",
    description:
      "Fetch current, version-specific documentation and code examples for libraries and frameworks. Helps agents avoid outdated APIs.",
    url: "https://mcp.context7.com/mcp",
    registry: { name: "io.github.upstash/context7", version: "4.4.4" },
    categories: ["code"],
    websiteUrl: "https://context7.com",
    icon: CURATED_ICONS["context7"],
  },
  {
    // sign-in: 401 OAuth
    id: "sentry",
    accountRequired: true,
    displayName: "Sentry",
    tagline: "Errors, issues and performance data",
    description:
      "Look up Sentry issues, errors and traces for your projects. Helps agents debug with real production context.",
    url: "https://mcp.sentry.dev/mcp",
    registry: { name: "io.github.getsentry/sentry-mcp", version: "0.42.0" },
    categories: ["code"],
    websiteUrl: "https://sentry.io",
    icon: CURATED_ICONS["sentry"],
  },
  {
    // sign-in: 401 OAuth
    id: "vercel",
    accountRequired: true,
    displayName: "Vercel",
    tagline: "Projects, deployments and logs",
    description:
      "Inspect Vercel projects and deployments, read build logs and search Vercel documentation. Access follows the teams you authorize.",
    url: "https://mcp.vercel.com",
    registry: { name: "com.vercel/vercel-mcp", version: "0.0.3" },
    categories: ["code"],
    websiteUrl: "https://vercel.com",
    icon: CURATED_ICONS["vercel"],
  },
  {
    // open: 200 "docs-ai-search" 0.4.14
    id: "cloudflare-docs",
    accountRequired: false,
    displayName: "Cloudflare Docs",
    tagline: "Search Cloudflare developer documentation",
    description:
      "Search Cloudflare's developer documentation for Workers, R2, D1 and the rest of the platform. No account needed.",
    url: "https://docs.mcp.cloudflare.com/mcp",
    registry: { name: "com.cloudflare.mcp/mcp", version: "1.0.0" },
    categories: ["code"],
    websiteUrl: "https://developers.cloudflare.com",
    icon: CURATED_ICONS["cloudflare-docs"],
  },
  {
    // open: 200 "Microsoft Learn MCP Server" 1.0.0
    id: "microsoft-learn",
    accountRequired: false,
    displayName: "Microsoft Learn",
    tagline: "Official Microsoft and Azure documentation",
    description:
      "Search and read Microsoft Learn documentation and code samples for Azure, .NET, Microsoft 365 and more. No account needed.",
    url: "https://learn.microsoft.com/api/mcp",
    registry: { name: "com.microsoft/microsoft-learn-mcp", version: "1.0.0" },
    categories: ["code"],
    websiteUrl: "https://learn.microsoft.com",
    icon: CURATED_ICONS["microsoft-learn"],
  },

  // ── Writing ─────────────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "notion",
    accountRequired: true,
    agentStores: { codex: "notion" },
    displayName: "Notion",
    tagline: "Pages, databases and lab notes",
    description:
      "Search, read and update Notion pages and databases. Keeps project notes, protocols and reading lists close to your agent.",
    url: "https://mcp.notion.com/mcp",
    registry: { name: "com.notion/mcp", version: "1.0.1" },
    categories: ["writing", "teamwork"],
    websiteUrl: "https://www.notion.com",
    icon: CURATED_ICONS["notion"],
  },
  {
    // sign-in: 401 OAuth
    id: "atlassian",
    accountRequired: true,
    displayName: "Atlassian",
    tagline: "Confluence pages and Jira issues",
    description:
      "Search and update Confluence pages and Jira issues in your Atlassian Cloud sites. Access follows your Atlassian permissions.",
    url: "https://mcp.atlassian.com/v1/mcp",
    categories: ["teamwork", "writing"],
    websiteUrl: "https://www.atlassian.com",
    icon: CURATED_ICONS["atlassian"],
  },
  {
    // sign-in: 401 OAuth
    id: "coda",
    accountRequired: true,
    displayName: "Coda",
    tagline: "Docs, tables and automations",
    description:
      "Read and edit Coda docs, pages and tables. Useful when shared protocols and trackers live in Coda.",
    url: "https://coda.io/apis/mcp",
    categories: ["writing", "teamwork"],
    websiteUrl: "https://coda.io",
    icon: CURATED_ICONS["coda"],
  },

  // ── Communication ───────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "linear",
    accountRequired: true,
    agentStores: { codex: "linear" },
    displayName: "Linear",
    tagline: "Issues, projects and cycles",
    description:
      "Create, search and update Linear issues and projects. Keeps your agent's work tied to the team's plan.",
    url: "https://mcp.linear.app/mcp",
    registry: { name: "app.linear/linear", version: "1.0.1" },
    categories: ["teamwork", "code"],
    websiteUrl: "https://linear.app",
    icon: CURATED_ICONS["linear"],
  },
  {
    // sign-in: 401 OAuth
    id: "monday",
    accountRequired: true,
    displayName: "monday.com",
    tagline: "Boards, items and updates",
    description:
      "Read and update monday.com boards and items. Access follows the account you authorize.",
    url: "https://mcp.monday.com/mcp",
    registry: { name: "com.monday/monday.com", version: "0.0.1" },
    categories: ["teamwork"],
    websiteUrl: "https://monday.com",
    icon: CURATED_ICONS["monday"],
  },
  {
    // sign-in: 401 OAuth
    id: "clickup",
    accountRequired: true,
    displayName: "ClickUp",
    tagline: "Tasks, docs and workspaces",
    description:
      "Search and update ClickUp tasks, lists and docs. Access follows your ClickUp workspace permissions.",
    url: "https://mcp.clickup.com/mcp",
    categories: ["teamwork"],
    websiteUrl: "https://clickup.com",
    icon: CURATED_ICONS["clickup"],
  },
  {
    // sign-in: 401 OAuth
    id: "fireflies",
    accountRequired: true,
    displayName: "Fireflies",
    tagline: "Meeting transcripts and summaries",
    description:
      "Search meeting transcripts and summaries recorded by Fireflies. Useful for recalling decisions from lab meetings and interviews.",
    url: "https://api.fireflies.ai/mcp",
    registry: { name: "ai.fireflies/fireflies", version: "1.1.0" },
    categories: ["teamwork"],
    websiteUrl: "https://fireflies.ai",
    icon: CURATED_ICONS["fireflies"],
  },
  {
    // sign-in: 401 OAuth
    id: "granola",
    accountRequired: true,
    displayName: "Granola",
    tagline: "Your meeting notes",
    description:
      "Search and read the meeting notes you took with Granola. Access follows the account you authorize.",
    url: "https://mcp.granola.ai/mcp",
    categories: ["teamwork"],
    websiteUrl: "https://www.granola.ai",
    icon: CURATED_ICONS["granola"],
  },
  {
    // sign-in: 401 OAuth
    id: "todoist",
    accountRequired: true,
    displayName: "Todoist",
    tagline: "Tasks and projects in Todoist",
    description:
      "Add, find and complete Todoist tasks and projects. Access follows the account you authorize.",
    url: "https://ai.todoist.net/mcp",
    registry: { name: "net.todoist/mcp", version: "1.0.0" },
    categories: ["teamwork"],
    websiteUrl: "https://www.todoist.com",
    icon: CURATED_ICONS["todoist"],
  },

  // ── Design ──────────────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "biorender",
    accountRequired: true,
    displayName: "BioRender",
    tagline: "Scientific figures and icons",
    description:
      "Find BioRender icons and templates for scientific figures. Access follows your BioRender account.",
    url: "https://mcp.services.biorender.com/mcp",
    categories: ["featured", "figures"],
    websiteUrl: "https://www.biorender.com",
    icon: CURATED_ICONS["biorender"],
  },
  {
    // sign-in: 401 OAuth
    id: "canva",
    accountRequired: true,
    displayName: "Canva",
    tagline: "Create and edit Canva designs",
    description:
      "Search, create and edit Canva designs such as posters and slides. Access follows your Canva account.",
    url: "https://mcp.canva.com/mcp",
    registry: { name: "com.canva.mcp/mcp", version: "1.0.0" },
    categories: ["figures"],
    websiteUrl: "https://www.canva.com",
    icon: CURATED_ICONS["canva"],
  },
  {
    // sign-in: 401 OAuth
    id: "miro",
    accountRequired: true,
    displayName: "Miro",
    tagline: "Boards, diagrams and sticky notes",
    description:
      "Read and create content on Miro boards, from diagrams to brainstorms. Access follows your Miro account.",
    url: "https://mcp.miro.com/",
    registry: { name: "io.github.miroapp/mcp-server", version: "1.0.2" },
    categories: ["figures", "teamwork"],
    websiteUrl: "https://miro.com",
    icon: CURATED_ICONS["miro"],
  },
  {
    // open: 200 "Excalidraw" 1.0.0
    id: "excalidraw",
    accountRequired: false,
    displayName: "Excalidraw",
    tagline: "Hand-drawn style diagrams",
    description:
      "Have your agent sketch diagrams and export them to Excalidraw for editing. No account needed.",
    url: "https://mcp.excalidraw.com/mcp",
    categories: ["figures"],
    websiteUrl: "https://excalidraw.com",
    icon: CURATED_ICONS["excalidraw"],
  },
  {
    // sign-in: 401 OAuth
    id: "mermaid-chart",
    accountRequired: true,
    displayName: "Mermaid Chart",
    tagline: "Mermaid diagrams you can edit and share",
    description:
      "Create and edit Mermaid diagrams such as flowcharts and sequence diagrams in Mermaid Chart. Access follows your Mermaid Chart account.",
    url: "https://mcp.mermaidchart.com/mcp",
    registry: { name: "com.mermaidchart/mermaid-mcp", version: "1.0.0" },
    categories: ["figures"],
    websiteUrl: "https://www.mermaidchart.com",
    icon: CURATED_ICONS["mermaid-chart"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (7 tools).
    id: "crossref",
    displayName: "Crossref (community)",
    tagline: "DOIs, references and scholarly metadata",
    description:
      "Resolve DOIs, retrieve references and search scholarly metadata. Hosted by Casey Hand, independently of Crossref; abstracts retain their copyright.",
    url: "https://crossref.caseyjhand.com/mcp",
    categories: ["papers", "writing"],
    websiteUrl: "https://www.crossref.org",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["crossref"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (4 tools).
    id: "europe-pmc",
    displayName: "Europe PMC (community)",
    tagline: "Literature, full text and biomedical annotations",
    description:
      "Discover and query Europe PMC APIs for literature and annotations. Hosted independently by QuentinCody; full-text reuse follows each article licence.",
    url: "https://europepmc-mcp-server.quentincody.workers.dev/mcp",
    categories: ["papers", "biology"],
    websiteUrl: "https://europepmc.org",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["europe-pmc"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (8 tools).
    id: "inspire",
    displayName: "CERN INSPIRE-HEP (community)",
    tagline: "Physics literature, citations and experiments",
    description:
      "Find high-energy physics papers, authors, experiments and citations. Hosted independently by Casey Hand; source content retains its own terms.",
    url: "https://cern-inspire.caseyjhand.com/mcp",
    categories: ["papers", "physics-math"],
    websiteUrl: "https://inspirehep.net",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["inspire"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (6 tools).
    id: "datacite",
    displayName: "DataCite (community)",
    tagline: "Find dataset and software DOIs",
    description:
      "Search DataCite metadata for datasets, software and other research outputs. Hosted independently by Casey Hand; each research output has its own licence.",
    url: "https://datacite.caseyjhand.com/mcp",
    categories: ["papers", "data"],
    websiteUrl: "https://datacite.org",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["datacite"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://support.elicit.com/en/articles/14757404-use-elicit-via-mcp-server.
    id: "elicit",
    displayName: "Elicit",
    tagline: "Literature and structured evidence reviews",
    description:
      "Search literature and trials and build structured evidence reviews. Requires Pro, Scale or Enterprise; quotas and source-paper copyright apply.",
    url: "https://elicit.com/api/mcp",
    categories: ["papers", "biology"],
    websiteUrl: "https://elicit.com",
    accountRequired: true,
    paidPlan: true,
    icon: CURATED_ICONS["elicit"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (36 tools).
    id: "rcsb-pdb",
    displayName: "RCSB PDB",
    tagline: "Protein structures, ligands and sequence relationships",
    description:
      "Search macromolecular structures, ligands and sequence relationships through RCSB’s official beta server. Tools may change; cite structures and their underlying papers.",
    url: "https://mcp-beta.rcsb.org/mcp",
    categories: ["biology", "chemistry"],
    websiteUrl: "https://www.rcsb.org",
    accountRequired: false,
    beta: true,
    icon: CURATED_ICONS["rcsb-pdb"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (6 tools).
    id: "interpro",
    displayName: "InterPro (community)",
    tagline: "Protein families, domains and functional sites",
    description:
      "Explore protein families, domains and functional sites in InterPro. Hosted independently by Casey Hand using EMBL-EBI resources.",
    url: "https://interpro.caseyjhand.com/mcp",
    categories: ["biology"],
    websiteUrl: "https://www.ebi.ac.uk/interpro",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["interpro"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://apidoc.protocols.io/.
    id: "protocols-io",
    displayName: "protocols.io",
    tagline: "Find and read experimental protocols",
    description:
      "Retrieve published experimental protocols through an authorised account. Content licences and private-protocol permissions still apply.",
    url: "https://www.protocols.io/mcp",
    categories: ["biology", "papers"],
    websiteUrl: "https://www.protocols.io",
    accountRequired: true,
    icon: CURATED_ICONS["protocols-io"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://help.pluto.bio/articles/3533751735-pluto-bio-mcp-connector.
    id: "pluto-bio",
    displayName: "Pluto Bio",
    tagline: "Programs, datasets, analyses and plots",
    description:
      "Work with programs, datasets, analysis spaces and plots in Pluto. Requires organisation access; the connector supports both reading and changes under your permissions.",
    url: "https://app.pluto.bio/mcp",
    categories: ["biology", "data"],
    websiteUrl: "https://pluto.bio",
    accountRequired: true,
    icon: CURATED_ICONS["pluto-bio"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://mavenbio.com/integrations/mcp.
    id: "maven-bio",
    displayName: "Maven Bio",
    tagline: "Drug, target, trial and biopharma evidence",
    description:
      "Read linked drug, target, trial and biopharma evidence records. Requires an active account with connector access; commercial subscription and reuse restrictions apply.",
    url: "https://mcp.mavenbio.com",
    categories: ["biology", "chemistry"],
    websiteUrl: "https://mavenbio.com",
    accountRequired: true,
    paidPlan: true,
    icon: CURATED_ICONS["maven-bio"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://help.benchling.com/hc/en-us/articles/40342713479437-Benchling-MCP.
    id: "benchling-lab",
    displayName: "Benchling lab data",
    tagline: "Query your lab’s authorised Benchling records",
    description:
      "Connect to your lab’s Benchling tenant with OAuth. Your administrator must enable the required AI features; unavailable on Benchling for Academics.",
    url: "https://<tenant>.mcp.benchling.com/mcp",
    categories: ["biology"],
    websiteUrl: "https://www.benchling.com",
    accountRequired: true,
    paidPlan: true,
    address: {
      urlTemplate: "https://<tenant>.mcp.benchling.com/mcp",
      fieldLabel: "Your Benchling address",
      placeholder: "https://your-lab.mcp.benchling.com/mcp",
    },
    icon: CURATED_ICONS["benchling-lab"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (1 tools).
    id: "benchling-docs",
    displayName: "Benchling developer documentation",
    tagline: "Search Benchling API and developer documentation",
    description:
      "Search public Benchling developer documentation. This connector reads documentation, not your lab’s notebooks, inventory or experimental records.",
    url: "https://docs.benchling.com/_mcp/server",
    categories: ["biology", "code"],
    websiteUrl: "https://docs.benchling.com",
    accountRequired: false,
    icon: CURATED_ICONS["benchling-docs"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (10 tools).
    id: "pubchem",
    displayName: "PubChem (community)",
    tagline: "Compounds, structures, properties and bioactivity",
    description:
      "Find compounds, structures, properties and bioactivity through PubChem. Hosted independently by Casey Hand; contributor data rights vary and hazard annotations do not replace lab safety procedures.",
    url: "https://pubchem.caseyjhand.com/mcp",
    categories: ["chemistry", "biology"],
    websiteUrl: "https://pubchem.ncbi.nlm.nih.gov",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["pubchem"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (3 tools).
    id: "materials-project-docs",
    displayName: "Materials Project documentation",
    tagline: "Search Materials Project documentation",
    description:
      "Search and read Materials Project documentation through its official GitBook endpoint. This is documentation access, not queries against the materials database.",
    url: "https://docs.materialsproject.org/~gitbook/mcp",
    categories: ["chemistry", "code"],
    websiteUrl: "https://docs.materialsproject.org",
    accountRequired: false,
    icon: CURATED_ICONS["materials-project-docs"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (7 tools).
    id: "nasa-earthdata",
    displayName: "NASA Earthdata",
    tagline: "Discover Earth-observation datasets and granules",
    description:
      "Discover Earth-observation collections, granules, variables and citations through NASA’s official server. Discovery needs no account; downloads and transformations may require Earthdata Login and separate services.",
    url: "https://cmr.earthdata.nasa.gov/mcp/v1",
    categories: ["earth", "data", "featured"],
    websiteUrl: "https://www.earthdata.nasa.gov",
    accountRequired: false,
    icon: CURATED_ICONS["nasa-earthdata"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (4 tools).
    id: "earthquakes",
    displayName: "Earthquakes USGS/EMSC (community)",
    tagline: "Earthquake events from USGS and EMSC",
    description:
      "Find earthquake events from USGS and EMSC. Hosted independently by Casey Hand; source attribution and accuracy limitations apply.",
    url: "https://earthquake.caseyjhand.com/mcp",
    categories: ["earth"],
    websiteUrl: "https://earthquake.usgs.gov",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["earthquakes"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (10 tools).
    id: "inaturalist",
    displayName: "iNaturalist (community)",
    tagline: "Species observations and biodiversity records",
    description:
      "Explore species observations and biodiversity records from iNaturalist. Hosted independently by Casey Hand; observations and photographs have individual licences.",
    url: "https://inaturalist.caseyjhand.com/mcp",
    categories: ["earth", "biology"],
    websiteUrl: "https://www.inaturalist.org",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["inaturalist"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (6 tools).
    id: "faostat",
    displayName: "FAOSTAT (community)",
    tagline: "Food and agriculture statistics",
    description:
      "Explore food and agriculture statistics from FAOSTAT. Hosted independently by Casey Hand; cite FAO and observe dataset-specific terms.",
    url: "https://faostat.caseyjhand.com/mcp",
    categories: ["earth", "data"],
    websiteUrl: "https://www.fao.org/faostat",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["faostat"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (16 tools).
    id: "world-bank",
    displayName: "World Bank Data360",
    tagline: "Development indicators and economic time series",
    description:
      "Find development indicators, metadata and time series through the World Bank’s official Data360 server. World Bank open data generally uses CC BY 4.0; some datasets have additional restrictions.",
    url: "https://maimcpext.worldbank.org/ext/data360/mcp",
    categories: ["social-science", "earth", "data"],
    websiteUrl: "https://data360.worldbank.org",
    accountRequired: false,
    icon: CURATED_ICONS["world-bank"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://fred.stlouisfed.org/help/data/connecting-fred-to-ai-services/FRED-MCP-Connector.
    id: "fred",
    displayName: "FRED",
    tagline: "Economic series, observations and graphs",
    description:
      "Search economic series, inspect methods and retrieve observations. Needs a free MCP Connector account distinct from a normal FRED account; per-series copyright and attribution apply.",
    url: "https://mcp.stlouisfed.org",
    categories: ["social-science", "data"],
    websiteUrl: "https://fred.stlouisfed.org",
    accountRequired: true,
    accessNote: "Free MCP Connector account",
    icon: CURATED_ICONS["fred"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (8 tools).
    id: "us-census",
    displayName: "US Census (community)",
    tagline: "US population and demographic statistics",
    description:
      "Explore US Census population and demographic statistics. Hosted independently by Casey Hand; cite the underlying survey and its methodology.",
    url: "https://census.caseyjhand.com/mcp",
    categories: ["social-science", "data"],
    websiteUrl: "https://www.census.gov",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["us-census"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (8 tools).
    id: "eurostat",
    displayName: "Eurostat (community)",
    tagline: "European statistics and indicator datasets",
    description:
      "Explore European statistics and indicator datasets from Eurostat. Hosted independently by Casey Hand; attribution and dataset conditions apply.",
    url: "https://eurostat.caseyjhand.com/mcp",
    categories: ["social-science", "data"],
    websiteUrl: "https://ec.europa.eu/eurostat",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["eurostat"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (3 tools).
    id: "grants-gov",
    displayName: "Grants.gov (community)",
    tagline: "Find federal research funding opportunities",
    description:
      "Search US federal funding opportunities and read eligibility and deadlines. Hosted independently by Casey Hand; verify current requirements with the funding agency.",
    url: "https://grantsgov.caseyjhand.com/mcp",
    categories: ["social-science", "papers", "teamwork"],
    websiteUrl: "https://www.grants.gov",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["grants-gov"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (3 tools).
    id: "osf",
    displayName: "OSF via Wanatux (community)",
    tagline: "Read known public OSF projects",
    description:
      "Read public OSF projects, abstracts and child components by project ID. Hosted independently by Wanatux Labs; this is not global OSF discovery or preregistration management.",
    url: "https://labs.wanatux.net/mcp",
    categories: ["social-science", "papers"],
    websiteUrl: "https://osf.io",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["osf"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (6 tools).
    id: "zenodo",
    displayName: "Zenodo (community)",
    tagline: "Find datasets, software, versions and files",
    description:
      "Find Zenodo datasets, software, DOI metadata, versions and files. Hosted independently by Casey Hand; each record and file has its own licence and access restrictions.",
    url: "https://zenodo.caseyjhand.com/mcp",
    categories: ["data", "papers", "writing"],
    websiteUrl: "https://zenodo.org",
    accountRequired: false,
    hosting: "Community",
    icon: CURATED_ICONS["zenodo"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (9 tools).
    id: "bigquery",
    displayName: "Google BigQuery",
    tagline: "Query research data in Google Cloud",
    description:
      "Explore and query BigQuery datasets using Google Cloud sign-in. Project permissions and query billing apply.",
    url: "https://bigquery.googleapis.com/mcp",
    categories: ["data"],
    websiteUrl: "https://cloud.google.com/bigquery",
    accountRequired: true,
    accessNote: "Google Cloud sign-in; query costs apply",
    icon: CURATED_ICONS["bigquery"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://docs.datacommons.org/mcp/run_tools.html.
    id: "data-commons",
    displayName: "Data Commons",
    tagline: "Public statistical indicators across sources",
    description:
      "Query public statistical indicators in Google’s Data Commons. Requires a free API key; cite the original datasets and observe their individual licences.",
    url: "https://api.datacommons.org/mcp",
    categories: ["data", "social-science"],
    websiteUrl: "https://datacommons.org",
    accountRequired: true,
    apiKey: {
      strategy: "header",
      headerName: "X-API-Key",
      fieldLabel: "Data Commons API key",
      helpUrl: "https://apikeys.datacommons.org",
    },
    icon: CURATED_ICONS["data-commons"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://docs.dimensions.ai/dsl/mcp.html.
    id: "dimensions",
    displayName: "Dimensions Analytics",
    tagline: "Publication, grant and research analytics",
    description:
      "Search publications, grants and researchers and run research analytics. Requires an API subscription and bearer API key; subscription and reasonable-use restrictions apply.",
    url: "https://app.dimensions.ai/mcp",
    categories: ["papers", "data"],
    websiteUrl: "https://www.dimensions.ai",
    accountRequired: true,
    paidPlan: true,
    apiKey: {
      strategy: "bearer",
      fieldLabel: "Dimensions API key",
      helpUrl: "https://docs.dimensions.ai/dsl/mcp.html",
    },
    icon: CURATED_ICONS["dimensions"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://developer.box.com/guides/box-mcp/.
    id: "box",
    displayName: "Box",
    tagline: "Find and work with files in Box",
    description:
      "Find and work with files in your Box account. OAuth and organisation permissions govern access and changes.",
    url: "https://mcp.box.com",
    categories: ["writing"],
    websiteUrl: "https://www.box.com",
    accountRequired: true,
    accessNote: "Registered OAuth client needed",
    oauthClientRequired: true,
    icon: CURATED_ICONS["box"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://help.dropbox.com/integrations/connect-dropbox-mcp-server.
    id: "dropbox",
    displayName: "Dropbox",
    tagline: "Search, read and organise Dropbox files",
    description:
      "Search, read and organise files in your Dropbox account. OAuth permissions apply; automatic registration is limited to vendor-supported clients.",
    url: "https://mcp.dropbox.com/mcp",
    categories: ["writing"],
    websiteUrl: "https://www.dropbox.com",
    accountRequired: true,
    accessNote: "Vendor-supported OAuth clients only",
    icon: CURATED_ICONS["dropbox"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://docs.slack.dev/ai/slack-mcp-server/.
    id: "slack",
    displayName: "Slack",
    tagline: "Search conversations and collaborate in Slack",
    description:
      "Search conversations and files and collaborate in Slack. Requires a registered OAuth application and workspace authorisation; your account permissions apply.",
    url: "https://mcp.slack.com/mcp",
    categories: ["teamwork"],
    websiteUrl: "https://slack.com",
    accountRequired: true,
    accessNote: "Registered OAuth client needed",
    oauthClientRequired: true,
    icon: CURATED_ICONS["slack"],
  },
  {
    // Verified 2026-10-28: vendor setup: https://developers.asana.com/docs/using-asanas-mcp-server.
    id: "asana",
    displayName: "Asana",
    tagline: "Projects, tasks and team coordination",
    description:
      "Work with projects and tasks in Asana. Requires a registered OAuth client and account authorisation; your workspace permissions apply.",
    url: "https://mcp.asana.com/v2/mcp",
    categories: ["teamwork"],
    websiteUrl: "https://asana.com",
    accountRequired: true,
    accessNote: "Registered OAuth client needed",
    oauthClientRequired: true,
    icon: CURATED_ICONS["asana"],
  },
  {
    // Verified 2026-10-28: initialize + tools/list (2 tools).
    id: "exa",
    displayName: "Exa",
    tagline: "Web research and page search",
    description:
      "Search the wider web and fetch pages for research. Web results are not peer-review certification; vendor limits and third-party content rights apply.",
    url: "https://mcp.exa.ai/mcp",
    categories: ["papers", "code"],
    websiteUrl: "https://exa.ai",
    accountRequired: false,
    icon: CURATED_ICONS["exa"],
  },
];

/** A URL compared as a connector address: parsed, without a trailing path slash. */
export const canonicalConnectorUrl = (url: string): string => {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.hash = "";
  const href = parsed.href;
  return parsed.pathname.length > 1 && href.endsWith("/") ? href.slice(0, -1) : href;
};

/** The curated server whose endpoint is `url`, compared canonically. */
export const curatedServerForUrl = (
  url: string,
  servers: ReadonlyArray<CuratedServer> = CURATED_SERVERS,
): CuratedServer | undefined => {
  const canonical = canonicalConnectorUrl(url);
  return servers.find((server) =>
    server.address
      ? matchesExtensionAddressTemplate(url, server.address.urlTemplate)
      : canonicalConnectorUrl(server.url) === canonical,
  );
};

/** The Discover entry for a curated server, before installation state. */
export const curatedDiscoverEntry = (
  server: CuratedServer,
): Omit<DiscoverEntry, "installedConnectorId"> => ({
  name: server.registry?.name ?? `${CURATED_NAME_PREFIX}${server.id}`,
  version: server.registry?.version ?? CATALOG_VERIFIED_ON,
  title: server.displayName,
  ...(server.agentStores ? { agentStores: server.agentStores } : {}),
  ...(server.accountRequired !== undefined ? { accountRequired: server.accountRequired } : {}),
  ...(server.oauthClientRequired ? { oauthClientRequired: true } : {}),
  hosting:
    server.hosting ??
    (server.url.includes(".caseyjhand.com/")
      ? "Community"
      : /https:\/\/(hcls|pubmed)\.mcp\.claude\.com\//.test(server.url)
        ? "Hosted by Anthropic"
        : "Official"),
  ...(server.paidPlan ? { paidPlan: true } : {}),
  ...(server.beta ? { beta: true } : {}),
  ...(server.accessNote ? { accessNote: server.accessNote } : {}),
  ...(server.apiKey ? { apiKey: server.apiKey } : {}),
  ...(server.address ? { address: server.address } : {}),
  description: server.description,
  tagline: server.tagline,
  categories: [...server.categories],
  websiteUrl: server.websiteUrl,
  iconUrl: server.icon,
  remotes: [
    { type: "streamable-http", url: server.url, requiresInput: server.address !== undefined },
  ],
  installable: true,
});
