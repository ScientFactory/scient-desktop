/**
 * Re-verify MCP initialization and registry identity before changing curated entries. Bundle
 * official icons rather than fetching at runtime; they identify third-party services without
 * affiliation or endorsement.
 */
import type { DiscoverEntry, ExtensionCategory } from "@t3tools/contracts";

import CURATED_ICONS from "./curatedIcons.json" with { type: "json" };

const CATALOG_VERIFIED_ON = "2026-10-21";

/** Names of curated servers not listed in the MCP Registry. Install them by URL. */
export const CURATED_NAME_PREFIX = "scient.curated/";

/** Section order on the Discover home page. */
export const CATALOG_CATEGORY_ORDER: ReadonlyArray<ExtensionCategory> = [
  "featured",
  "research",
  "biology",
  "math-cs",
  "data",
  "code",
  "writing",
  "communication",
  "design",
];

export const CATALOG_SECTIONS: Readonly<
  Record<ExtensionCategory, { readonly title: string; readonly description: string }>
> = {
  featured: { title: "Featured", description: "Strong picks to start with." },
  research: {
    title: "Research",
    description: "Literature, citations, models and biomedical knowledge.",
  },
  biology: {
    title: "Biology & genetics",
    description: "Genes, proteins, drug targets, preprints and clinical studies.",
  },
  "math-cs": {
    title: "Math & computer science",
    description: "Symbolic computation, research papers and integer sequences.",
  },
  data: { title: "Data", description: "Datasets, notebooks and databases." },
  code: { title: "Code", description: "Repositories, documentation and developer tools." },
  writing: { title: "Writing", description: "Documents, wikis and file storage." },
  communication: {
    title: "Communication",
    description: "Chat, meetings and project tracking.",
  },
  design: { title: "Design", description: "Figures, diagrams, slides and design files." },
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
    categories: ["research", "biology"],
    websiteUrl: "https://pubmed.ncbi.nlm.nih.gov",
    icon: CURATED_ICONS["pubmed"],
  },
  {
    // open: 200 "Asta Scientific Corpus Tool" 1.9.4
    id: "semantic-scholar",
    displayName: "Semantic Scholar",
    tagline: "Search papers, authors and citations",
    description:
      "Ai2's Semantic Scholar corpus for agents. Search papers by relevance or title, read citations and author publication lists, and pull matching snippets from paper text.",
    url: "https://api.semanticscholar.org/mcp",
    categories: ["featured", "research"],
    websiteUrl: "https://www.semanticscholar.org",
    icon: CURATED_ICONS["semantic-scholar"],
  },
  {
    // sign-in: 401 OAuth (free OpenAlex account)
    id: "openalex",
    displayName: "OpenAlex",
    tagline: "Open catalog of scholarly works and authors",
    description:
      "Query OpenAlex, the open index of research papers, authors, institutions and citations. Useful for literature mapping and bibliometrics; sign in with a free OpenAlex account.",
    url: "https://mcp.openalex.org/mcp",
    registry: { name: "org.openalex/openalex", version: "0.5.0" },
    categories: ["featured", "research"],
    websiteUrl: "https://openalex.org",
    icon: CURATED_ICONS["openalex"],
  },
  {
    // sign-in: 401 OAuth
    id: "scholar-gateway",
    displayName: "Scholar Gateway",
    tagline: "Peer-reviewed research from Wiley",
    description:
      "Wiley's gateway to peer-reviewed literature for AI assistants. Search scholarly content and get answers grounded in citable sources.",
    url: "https://connector.scholargateway.ai/mcp",
    categories: ["research"],
    websiteUrl: "https://scholargateway.ai",
    icon: CURATED_ICONS["scholar-gateway"],
  },
  {
    // sign-in: 401 OAuth (scope "search")
    id: "consensus",
    displayName: "Consensus",
    tagline: "Evidence from peer-reviewed studies",
    description:
      "Search peer-reviewed research and see what studies conclude about a question. Results link back to the underlying papers.",
    url: "https://mcp.consensus.app/mcp",
    categories: ["research"],
    websiteUrl: "https://consensus.app",
    icon: CURATED_ICONS["consensus"],
  },
  {
    // sign-in: 401 OAuth
    id: "scite",
    displayName: "scite",
    tagline: "See how papers are cited",
    description:
      "Find papers and see whether later work supports or contrasts their claims. Uses scite's Smart Citations index; sign in with a scite account.",
    url: "https://api.scite.ai/mcp",
    registry: { name: "ai.scite/mcp", version: "1.0.0" },
    categories: ["research"],
    websiteUrl: "https://scite.ai",
    icon: CURATED_ICONS["scite"],
  },
  {
    // sign-in: 401 OAuth
    id: "synapse",
    displayName: "Synapse",
    tagline: "Biomedical research data from Sage Bionetworks",
    description:
      "Find and read projects, files and metadata on Synapse, Sage Bionetworks' platform for sharing biomedical research data. Access follows your Synapse permissions.",
    url: "https://mcp.synapse.org/mcp",
    categories: ["research", "data"],
    websiteUrl: "https://www.synapse.org",
    icon: CURATED_ICONS["synapse"],
  },
  {
    // open: 200 "huggingface.co/mcp" 0.4.31
    id: "hugging-face",
    displayName: "Hugging Face",
    tagline: "Models, datasets, Spaces and papers on the Hub",
    description:
      "Search the Hugging Face Hub for models, datasets, Spaces and papers, and read repository details and files. Works without an account; sign in to reach your private repositories.",
    url: "https://huggingface.co/mcp",
    registry: { name: "co.huggingface/hf-mcp-server", version: "0.2.33" },
    categories: ["featured", "research", "data"],
    websiteUrl: "https://huggingface.co",
    icon: CURATED_ICONS["hugging-face"],
  },
  {
    // open: 200 "Kaggle.Web" 1.0.0.0
    id: "kaggle",
    displayName: "Kaggle",
    tagline: "Datasets, notebooks and competitions",
    description:
      "Search and download Kaggle datasets, explore competitions and leaderboards, and work with notebooks and models. Some actions need a signed-in Kaggle account.",
    url: "https://www.kaggle.com/mcp",
    categories: ["data", "research"],
    websiteUrl: "https://www.kaggle.com",
    icon: CURATED_ICONS["kaggle"],
  },

  // ── Biology & genetics ──────────────────────────────────────────────────
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (7 tools).
    id: "biorxiv",
    displayName: "bioRxiv & medRxiv",
    tagline: "Biology and medicine before peer review",
    description:
      "Find preprints by topic, date or funder and follow their published versions. Anthropic's public connector searches both bioRxiv and medRxiv; these manuscripts have not yet been peer reviewed.",
    url: "https://hcls.mcp.claude.com/biorxiv/mcp",
    categories: ["biology"],
    websiteUrl: "https://www.biorxiv.org",
    icon: CURATED_ICONS["biorxiv"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (6 tools).
    id: "clinical-trials",
    displayName: "ClinicalTrials.gov",
    tagline: "Find studies, eligibility rules and trial results",
    description:
      "Search registered clinical studies by condition, sponsor or eligibility and read their endpoints and results. Uses Anthropic's public connector to ClinicalTrials.gov; no account needed.",
    url: "https://hcls.mcp.claude.com/clinical_trials/mcp",
    categories: ["biology"],
    websiteUrl: "https://clinicaltrials.gov",
    icon: CURATED_ICONS["clinical-trials"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (6 tools).
    id: "chembl",
    displayName: "ChEMBL",
    tagline: "Compounds, drug targets and measured activity",
    description:
      "Find bioactive compounds, protein targets and experimental activity measurements in EMBL-EBI's ChEMBL database. Anthropic's public connector also looks up drug mechanisms and molecular properties.",
    url: "https://hcls.mcp.claude.com/chembl/mcp",
    categories: ["biology"],
    websiteUrl: "https://www.ebi.ac.uk/chembl",
    icon: CURATED_ICONS["chembl"],
  },
  {
    // Verified 2026-10-26: no auth, initialize + tools/list (7 tools); exact registry remote.
    id: "ensembl-community",
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
    displayName: "Open Targets",
    tagline: "Target–disease evidence for drug discovery",
    description:
      "Query the Open Targets Platform for targets, diseases, drugs and the evidence linking them. Agents can search entities and run GraphQL queries against the platform.",
    url: "https://mcp.platform.opentargets.org/mcp",
    categories: ["biology"],
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
    categories: ["math-cs"],
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
    categories: ["math-cs", "research"],
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
    categories: ["math-cs"],
    websiteUrl: "https://github.com/cyanheads/oeis-mcp-server",
    icon: CURATED_ICONS["oeis-community"],
  },

  // ── Data ────────────────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "hex",
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
    displayName: "Supabase",
    tagline: "Postgres projects, tables and SQL",
    description:
      "Manage Supabase projects: inspect tables, run SQL, apply migrations and read logs. Access follows the organizations you authorize.",
    url: "https://mcp.supabase.com/mcp",
    registry: { name: "com.supabase/mcp", version: "0.14.0" },
    categories: ["data"],
    websiteUrl: "https://supabase.com",
    icon: CURATED_ICONS["supabase"],
  },
  {
    // sign-in: 401 OAuth
    id: "neon",
    displayName: "Neon",
    tagline: "Serverless Postgres with branching",
    description:
      "Create and manage Neon Postgres projects and branches, and run SQL against them. Branches make it safe to try schema changes.",
    url: "https://mcp.neon.tech/mcp",
    registry: { name: "com.neon/mcp", version: "1.0.0" },
    categories: ["data"],
    websiteUrl: "https://neon.com",
    icon: CURATED_ICONS["neon"],
  },
  {
    // sign-in: 401 OAuth
    id: "airtable",
    displayName: "Airtable",
    tagline: "Bases, tables and records",
    description:
      "Read and update records in your Airtable bases, and inspect their tables and fields. Handy for lab inventories and study trackers kept in Airtable.",
    url: "https://mcp.airtable.com/mcp",
    registry: { name: "com.airtable/mcp", version: "0.1.0" },
    categories: ["data"],
    websiteUrl: "https://www.airtable.com",
    icon: CURATED_ICONS["airtable"],
  },

  // ── Code ────────────────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "github",
    agentStores: { codex: "github" },
    displayName: "GitHub",
    tagline: "Repositories, issues and pull requests",
    description:
      "Work with GitHub repositories, issues, pull requests and Actions from your agent. Access follows the account and organizations you authorize.",
    url: "https://api.githubcopilot.com/mcp/",
    registry: { name: "io.github.github/github-mcp-server", version: "2.0.2" },
    categories: ["featured", "code"],
    websiteUrl: "https://github.com",
    icon: CURATED_ICONS["github"],
  },
  {
    // open: 200 "DeepWiki" 2.14.3
    id: "deepwiki",
    displayName: "DeepWiki",
    tagline: "Ask questions about any public GitHub repo",
    description:
      "Read generated documentation for public GitHub repositories and ask questions about how their code works. No account needed.",
    url: "https://mcp.deepwiki.com/mcp",
    categories: ["featured", "code"],
    websiteUrl: "https://deepwiki.com",
    icon: CURATED_ICONS["deepwiki"],
  },
  {
    // sign-in: 401 OAuth
    id: "gitlab",
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
    agentStores: { codex: "notion" },
    displayName: "Notion",
    tagline: "Pages, databases and lab notes",
    description:
      "Search, read and update Notion pages and databases. Keeps project notes, protocols and reading lists close to your agent.",
    url: "https://mcp.notion.com/mcp",
    registry: { name: "com.notion/mcp", version: "1.0.1" },
    categories: ["featured", "writing"],
    websiteUrl: "https://www.notion.com",
    icon: CURATED_ICONS["notion"],
  },
  {
    // sign-in: 401 OAuth
    id: "atlassian",
    displayName: "Atlassian",
    tagline: "Confluence pages and Jira issues",
    description:
      "Search and update Confluence pages and Jira issues in your Atlassian Cloud sites. Access follows your Atlassian permissions.",
    url: "https://mcp.atlassian.com/v1/mcp",
    categories: ["writing", "communication"],
    websiteUrl: "https://www.atlassian.com",
    icon: CURATED_ICONS["atlassian"],
  },
  {
    // sign-in: 401 OAuth
    id: "coda",
    displayName: "Coda",
    tagline: "Docs, tables and automations",
    description:
      "Read and edit Coda docs, pages and tables. Useful when shared protocols and trackers live in Coda.",
    url: "https://coda.io/apis/mcp",
    categories: ["writing"],
    websiteUrl: "https://coda.io",
    icon: CURATED_ICONS["coda"],
  },

  // ── Communication ───────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "linear",
    agentStores: { codex: "linear" },
    displayName: "Linear",
    tagline: "Issues, projects and cycles",
    description:
      "Create, search and update Linear issues and projects. Keeps your agent's work tied to the team's plan.",
    url: "https://mcp.linear.app/mcp",
    registry: { name: "app.linear/linear", version: "1.0.1" },
    categories: ["featured", "communication"],
    websiteUrl: "https://linear.app",
    icon: CURATED_ICONS["linear"],
  },
  {
    // sign-in: 401 OAuth
    id: "monday",
    displayName: "monday.com",
    tagline: "Boards, items and updates",
    description:
      "Read and update monday.com boards and items. Access follows the account you authorize.",
    url: "https://mcp.monday.com/mcp",
    registry: { name: "com.monday/monday.com", version: "0.0.1" },
    categories: ["communication"],
    websiteUrl: "https://monday.com",
    icon: CURATED_ICONS["monday"],
  },
  {
    // sign-in: 401 OAuth
    id: "clickup",
    displayName: "ClickUp",
    tagline: "Tasks, docs and workspaces",
    description:
      "Search and update ClickUp tasks, lists and docs. Access follows your ClickUp workspace permissions.",
    url: "https://mcp.clickup.com/mcp",
    categories: ["communication"],
    websiteUrl: "https://clickup.com",
    icon: CURATED_ICONS["clickup"],
  },
  {
    // sign-in: 401 OAuth
    id: "fireflies",
    displayName: "Fireflies",
    tagline: "Meeting transcripts and summaries",
    description:
      "Search meeting transcripts and summaries recorded by Fireflies. Useful for recalling decisions from lab meetings and interviews.",
    url: "https://api.fireflies.ai/mcp",
    registry: { name: "ai.fireflies/fireflies", version: "1.1.0" },
    categories: ["communication"],
    websiteUrl: "https://fireflies.ai",
    icon: CURATED_ICONS["fireflies"],
  },
  {
    // sign-in: 401 OAuth
    id: "granola",
    displayName: "Granola",
    tagline: "Your meeting notes",
    description:
      "Search and read the meeting notes you took with Granola. Access follows the account you authorize.",
    url: "https://mcp.granola.ai/mcp",
    categories: ["communication"],
    websiteUrl: "https://www.granola.ai",
    icon: CURATED_ICONS["granola"],
  },
  {
    // sign-in: 401 OAuth
    id: "todoist",
    displayName: "Todoist",
    tagline: "Tasks and projects in Todoist",
    description:
      "Add, find and complete Todoist tasks and projects. Access follows the account you authorize.",
    url: "https://ai.todoist.net/mcp",
    registry: { name: "net.todoist/mcp", version: "1.0.0" },
    categories: ["communication"],
    websiteUrl: "https://www.todoist.com",
    icon: CURATED_ICONS["todoist"],
  },

  // ── Design ──────────────────────────────────────────────────────────────
  {
    // sign-in: 401 OAuth
    id: "biorender",
    displayName: "BioRender",
    tagline: "Scientific figures and icons",
    description:
      "Find BioRender icons and templates for scientific figures. Access follows your BioRender account.",
    url: "https://mcp.services.biorender.com/mcp",
    categories: ["design"],
    websiteUrl: "https://www.biorender.com",
    icon: CURATED_ICONS["biorender"],
  },
  {
    // sign-in: 401 OAuth
    id: "canva",
    displayName: "Canva",
    tagline: "Create and edit Canva designs",
    description:
      "Search, create and edit Canva designs such as posters and slides. Access follows your Canva account.",
    url: "https://mcp.canva.com/mcp",
    registry: { name: "com.canva.mcp/mcp", version: "1.0.0" },
    categories: ["design"],
    websiteUrl: "https://www.canva.com",
    icon: CURATED_ICONS["canva"],
  },
  {
    // sign-in: 401 OAuth
    id: "miro",
    displayName: "Miro",
    tagline: "Boards, diagrams and sticky notes",
    description:
      "Read and create content on Miro boards, from diagrams to brainstorms. Access follows your Miro account.",
    url: "https://mcp.miro.com/",
    registry: { name: "io.github.miroapp/mcp-server", version: "1.0.2" },
    categories: ["design"],
    websiteUrl: "https://miro.com",
    icon: CURATED_ICONS["miro"],
  },
  {
    // open: 200 "Excalidraw" 1.0.0
    id: "excalidraw",
    displayName: "Excalidraw",
    tagline: "Hand-drawn style diagrams",
    description:
      "Have your agent sketch diagrams and export them to Excalidraw for editing. No account needed.",
    url: "https://mcp.excalidraw.com/mcp",
    categories: ["design"],
    websiteUrl: "https://excalidraw.com",
    icon: CURATED_ICONS["excalidraw"],
  },
  {
    // sign-in: 401 OAuth
    id: "mermaid-chart",
    displayName: "Mermaid Chart",
    tagline: "Mermaid diagrams you can edit and share",
    description:
      "Create and edit Mermaid diagrams such as flowcharts and sequence diagrams in Mermaid Chart. Access follows your Mermaid Chart account.",
    url: "https://mcp.mermaidchart.com/mcp",
    registry: { name: "com.mermaidchart/mermaid-mcp", version: "1.0.0" },
    categories: ["design"],
    websiteUrl: "https://www.mermaidchart.com",
    icon: CURATED_ICONS["mermaid-chart"],
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
  return servers.find((server) => canonicalConnectorUrl(server.url) === canonical);
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
  description: server.description,
  tagline: server.tagline,
  categories: [...server.categories],
  websiteUrl: server.websiteUrl,
  iconUrl: server.icon,
  remotes: [{ type: "streamable-http", url: server.url, requiresInput: false }],
  installable: true,
});
