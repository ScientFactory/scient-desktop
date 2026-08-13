import type { ScientReleaseNote } from "./model";

/**
 * Scient-owned, release-specific copy belongs here.
 *
 * Entries are added only after their exact release candidate and user-facing
 * copy have been approved. T3 release notes are not inherited as Scient
 * product communication.
 */
export const SCIENT_RELEASE_NOTES = [
  {
    version: "0.6.2",
    publishedAt: "2026-08-13",
    kicker: "Sources, citations, and stronger scientific documents",
    headline: "Scient 0.6.2",
    summary:
      "This release introduces a project-owned Sources library and strengthens the foundations for reliable scientific documents.",
    highlights: [
      {
        id: "project-sources",
        title: "Keep research sources with your project",
        description:
          "Build a durable project library for papers and PDFs without making Zotero or another external service the source of truth.",
      },
      {
        id: "zotero-and-local-import",
        title: "Import from Zotero or local PDFs",
        description:
          "Bring references in from a local Zotero library or add PDFs directly, with duplicate review and recoverable import operations.",
      },
      {
        id: "citations-and-metadata",
        title: "Review metadata and copy citations",
        description:
          "Inspect and correct source details, resolve DOI and PMID metadata, open attached PDFs, and copy references in common citation styles.",
      },
      {
        id: "scientific-document-foundation",
        title: "Stronger scientific document foundations",
        description:
          "Adds governed generated-PDF artifacts and safer Markdown preview handling, alongside release and documentation reliability improvements.",
      },
    ],
  },
  {
    version: "0.6.1",
    publishedAt: "2026-08-12",
    kicker: "Pull requests, General Chat improvements, and reliability fixes",
    headline: "Scient 0.6.1",
    summary:
      "This release adds pull-request tools and improves General Chat, Codex sign-in, themes, and platform reliability.",
    highlights: [
      {
        id: "pull-requests",
        title: "Pull requests",
        description:
          "Browse and manage pull requests from GitHub, GitLab, Bitbucket, and Azure DevOps. View code and timelines, submit reviews, and create local checkouts.",
      },
      {
        id: "general-chat-improvements",
        title: "General Chat improvements",
        description:
          "General Chat now has direct creation controls, persistent sidebar state, better workspace tools, and safer movement into a project.",
      },
      {
        id: "codex-setup-and-sign-in",
        title: "Codex setup and sign-in",
        description:
          "Improved runtime selection, sign-in confirmation, diagnostics, and recovery when multiple Codex installations are available.",
      },
      {
        id: "other-improvements",
        title: "Other improvements",
        description:
          "Includes voice-dictation fixes, theme and sidebar refinements, clearer usage information, and additional mobile, terminal, Git, and Windows fixes.",
      },
    ],
  },
  {
    version: "0.6.0",
    publishedAt: "2026-08-10",
    kicker: "A stronger foundation for scientific work",
    headline: "A more capable Scient for your next investigation",
    summary:
      "This first migrated release brings the refreshed Scient desktop together with the first workflows designed for scientific work.",
    highlights: [
      {
        id: "guided-provider-connection",
        title: "Connect your AI subscription with less friction",
        description:
          "Set up Codex or Claude from inside Scient with clear installation, sign-in, and model guidance.",
      },
      {
        id: "scientific-documents",
        title: "Read scientific documents in your project",
        description:
          "Open PDFs directly in the workspace with reliable project file discovery and a focused reading experience.",
      },
      {
        id: "voice-and-conversation-branches",
        title: "Speak, branch, and keep exploring",
        description:
          "Use local voice dictation and fork conversations when you want to pursue a different line of thought.",
      },
      {
        id: "math-and-bidirectional-text",
        title: "Keep Hebrew, English, and mathematics readable",
        description:
          "Improved bidirectional text handling keeps mixed-language prose, formulas, tables, and flow details coherent.",
      },
      {
        id: "project-start",
        title: "Start a project with less setup work",
        description:
          "Create a Scient project safely, preserve existing project guidance, and begin with a clearer general workspace.",
      },
    ],
  },
] as const satisfies readonly ScientReleaseNote[];
