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
    version: "0.6.9",
    publishedAt: "2026-08-31",
    kicker: "More ways to share, clearer figures, and smoother everyday work.",
    headline: "Share more files and work with cleaner figures",
    summary:
      "Scient 0.6.9 expands file attachments, makes figure controls movable, improves citations and PDF output, and fixes the release-notes link shown during updates.",
    highlights: [
      {
        id: "more-file-attachments",
        title: "Attach more kinds of files",
        description:
          "Share PDFs, spreadsheets, code, archives, and videos directly in conversations. Play supported videos inside Scient. File-size limits and provider capabilities still apply.",
      },
      {
        id: "compact-visual-cards",
        title: "Cleaner images and charts",
        description:
          "Figures have less surrounding clutter, with compact controls you can move out of the way. Available in chat and Markdown previews.",
      },
      {
        id: "clearer-citations-and-sources",
        title: "Find the right source",
        description:
          "Codex citations appear as readable, clickable links. When a source contains multiple PDFs, Scient asks which one you want instead of silently choosing.",
      },
      {
        id: "pdf-and-latex-fixes",
        title: "Better PDFs and clearer build feedback",
        description:
          "Exported PDFs avoid unnecessary page gaps around figures and captions. LaTeX build messages remain distinct, with repeated diagnostics removed and important errors preserved.",
      },
      {
        id: "refresh-and-update-links",
        title: "Less manual refreshing, fewer broken links",
        description:
          "Files and Git changes refresh after agent edits. Update notifications now open the correct Scient release notes instead of a missing page.",
      },
    ],
  },
  {
    version: "0.6.8",
    publishedAt: "2026-08-29",
    kicker: "Deeper scientific work, safer provider updates, and files that stay current.",
    headline: "Run stateful Python, give projects their own Skills, and build PDFs with agents",
    summary:
      "Scient 0.6.8 adds a stateful Python workspace, project-specific guidance for agents, and controlled PDF authoring. It also makes Scient-managed provider updates safer and reduces stale previews and unnecessary setup.",
    highlights: [
      {
        id: "stateful-python",
        title: "Run Python as a working session",
        description:
          "Run a selection, # %% cell, or complete Python file; inspect results and variables; interrupt, restart, or stop safely; and keep generated figures with the project. Scient uses a compatible Python environment you already control and never silently modifies it.",
      },
      {
        id: "project-skills",
        title: "Give each project its own Skills",
        description:
          "Add reusable instructions that apply only inside a project, and choose whether agents can select them automatically, use them only through $name, or not see them. The built-in Skill Authoring guidance helps create and improve them.",
      },
      {
        id: "agent-pdf-authoring",
        title: "Build PDFs with agents",
        description:
          "Agents can create editable project-owned HTML and turn it into a validated PDF through Scient's controlled local build. Source files and finished documents stay together, with local assets preserved and remote resources blocked.",
      },
      {
        id: "managed-provider-updates",
        title: "Update managed providers safely",
        description:
          "Scient now shows updates for supported Scient-managed providers. Every replacement is checked and tested before activation, the previous working version remains available if something fails, and system or custom installations are left untouched. Updates always require your action.",
      },
      {
        id: "current-files-and-simpler-defaults",
        title: "Spend less time refreshing and configuring",
        description:
          "File previews and HTML-exported PDFs follow changes on disk while preserving the last successful result on failure. Provider settings open on Models by default, signed-in account addresses are visible, and browser and Sources access start enabled while remaining fully configurable.",
      },
    ],
  },
  {
    version: "0.6.7",
    publishedAt: "2026-08-25",
    kicker: "Reusable guidance, simpler connections, and better local voice.",
    headline: "Guide agents with Skills, manage providers easily, and dictate more accurately",
    summary:
      "Scient 0.6.7 introduces reusable Skills, makes AI providers easier to install and manage, lets you continue a conversation with another provider, and gives you more choices for private voice dictation.",
    highlights: [
      {
        id: "scient-skills",
        title: "Teach agents how you like to work",
        description:
          "Skills are reusable instructions for common tasks. Open Settings → Skills to activate Scient's built-in skills, let agents use them automatically or call them yourself with $name, and see skills available from your connected providers.",
      },
      {
        id: "provider-management",
        title: "Set up and manage providers in one place",
        description:
          "Install, sign in, repair, update, or remove supported providers from a consistent screen. Keep using an existing installation or let Scient manage a private copy without changing the one already on your computer.",
      },
      {
        id: "continue-with-another-ai",
        title: "Start with one AI and continue with another",
        description:
          "Begin a conversation with one AI, then continue its context using a different provider or model. Scient creates a connected copy, keeps the original conversation unchanged, and carries over your unfinished message after you confirm.",
      },
      {
        id: "multilingual-voice-models",
        title: "Choose the right voice model for your computer",
        description:
          "Select Multilingual Small, Medium, or Turbo, choose your language, and continue editing while recording. Optional AI correction can improve spelling and punctuation; recorded audio remains on your computer.",
      },
      {
        id: "thread-and-attachment-refinements",
        title: "Smoother work across threads and attachments",
        description:
          "Attach HEIC photos, keep pull requests connected to their conversations, and open agent and file links more reliably across macOS and Windows.",
      },
    ],
  },
  {
    version: "0.6.6",
    publishedAt: "2026-08-23",
    kicker: "More ways to connect. Less friction once you're working.",
    headline:
      "Connect Antigravity, Cursor, or Grok; preserve browser documents as PDFs; and move through projects more easily",
    summary:
      "Scient 0.6.6 expands provider choice while tightening the desktop experience around it: onboarding stays short and optional, connection problems are easier to recover from, exported documents retain useful structure, and everyday navigation feels more direct.",
    highlights: [
      {
        id: "assisted-provider-connections",
        title: "Connect Antigravity, Cursor, and Grok",
        description:
          "Install and manage Scient-reviewed app-private runtimes for Antigravity and Cursor—or keep using existing CLIs—and sign in through their supported browser flows. Early Access Grok also gains assisted installation, repair, and browser or device-code sign-in from Settings or the composer.",
      },
      {
        id: "browser-pdf-export",
        title: "Export browser documents to PDF",
        description:
          "Export HTML open in Scient's integrated browser as an immutable PDF snapshot, then open it in Scient's PDF reader or save a copy. The export preserves selectable text, embedded fonts, RTL layout, outlines, and supported links where Chromium can retain them.",
      },
      {
        id: "provider-setup-recovery",
        title: "Start and recover setup more clearly",
        description:
          "A short, skippable flow helps a new empty workspace connect an AI, save optional local preferences, and start with a project. Provider screens also distinguish installation, sign-in, repair, removal, and account actions more clearly.",
      },
      {
        id: "thread-workflow-refinements",
        title: "Move faster through files, chats, and remotes",
        description:
          "Use clickable file breadcrumbs and copy relative or full paths. Follow-up messages keep their order, chats can be renamed directly, Mod+Enter can create a thread in the background, and remotes and terminals receive focused reliability fixes.",
      },
    ],
  },
  {
    version: "0.6.5",
    publishedAt: "2026-08-22",
    kicker: "New agent providers, a message queue, and effortless LaTeX navigation",
    headline: "More ways to run agents, fewer reasons to wait",
    summary:
      "Scient connects to Factory Droid in early access, ships built-in SyncTeX navigation with every install, queues messages while your agent works, and continues to absorb workspace improvements from the maintained T3 foundation.",
    highlights: [
      {
        id: "droid-provider",
        title: "Connect Factory Droid",
        description:
          "Work with Factory's Droid agent from Scient in early access. Sign in by device pairing or API key, pick models with per-model reasoning effort and cost labels, switch mid-thread, and steer running turns.",
      },
      {
        id: "built-in-synctex-navigation",
        title: "Jump between PDF and source anywhere",
        description:
          "Double-click navigation between PDF and LaTeX source now ships built in on every desktop platform and works with TinyTeX, TeX Live, MiKTeX, or Tectonic without extra setup.",
      },
      {
        id: "thread-message-queue",
        title: "Queue messages while the agent works",
        description:
          "Messages sent during a turn wait in a queue that auto-sends in order when the turn finishes. Steer immediately with Cmd/Ctrl+Enter, edit, reorder, delete, and rely on the queue across restarts.",
      },
      {
        id: "latex-managed-install-macos-linux",
        title: "One-click LaTeX setup on macOS and Linux x64",
        description:
          "The managed TinyTeX installation extends beyond Windows to macOS and Linux x64, and build errors become clickable links that open the exact file and line.",
      },
      {
        id: "agent-added-sources-review",
        title: "Let agents add sources for review",
        description:
          "Agents can add project PDFs to your Sources library and attach them to references. Additions are flagged for your review before they become part of the project record.",
      },
    ],
  },
  {
    version: "0.6.4",
    publishedAt: "2026-08-14",
    kicker: "MATLAB analysis, source notes, and smoother project work",
    headline: "Run MATLAB analyses inside Scient",
    summary:
      "Scient can now run project MATLAB files with your installed MATLAB, keep their results and figures close to the code, and make sources, projects, and local previews more dependable.",
    highlights: [
      {
        id: "matlab-run-file",
        title: "Run MATLAB files from your project",
        description:
          "Open a saved .m file, connect your existing MATLAB installation, follow its output and errors, and stop or revisit runs without leaving Scient.",
      },
      {
        id: "latex-editing-and-preview",
        title: "Edit and preview LaTeX documents",
        description:
          "Open a .tex file to edit the source, compile it, and preview the generated PDF side by side. Scient reports compiler errors and warnings, keeps build files out of your project, and can install TinyTeX automatically on Windows x64 when no LaTeX installation is available.",
      },
      {
        id: "matlab-results-and-figures",
        title: "Keep figures and results with each run",
        description:
          "Review captured figures in the workspace, open movable figure cards, download native FIG files, and see when results no longer match the saved source.",
      },
      {
        id: "source-notes",
        title: "Add notes directly to research sources",
        description:
          "Write persistent source notes with bold, italic, and bidirectional text support. Agents can work with the same project-owned notes when you ask them to.",
      },
    ],
  },
  {
    version: "0.6.3",
    publishedAt: "2026-08-13",
    kicker: "Complete source intake and a stronger everyday workspace",
    headline: "Scient 0.6.3",
    summary:
      "This release completes the first Sources intake workflow and brings a broad set of focused workspace improvements from the maintained T3 foundation.",
    highlights: [
      {
        id: "complete-source-intake",
        title: "Bring research sources into Scient more reliably",
        description:
          "Import local PDFs, selected Zotero references, collections, or a whole local library through clearer, recoverable workflows with stronger duplicate and metadata handling.",
      },
      {
        id: "source-awareness",
        title: "Let agents work with your project library",
        description:
          "Agents can now inspect the active project's source list and bounded reference details without exposing attachment paths or sources from another project.",
      },
      {
        id: "pull-request-workspace",
        title: "A more capable pull-request workspace",
        description:
          "Filter and review pull requests, inspect checks and smarter diffs, update branches, edit details, and work with reactions across supported source-control providers.",
      },
      {
        id: "workspace-polish-and-reliability",
        title: "More room for content and fewer interruptions",
        description:
          "File previews open content-first, restored non-PDF tabs no longer crash the workspace, and composer, sidebar, theme, diff, OAuth, and mobile interactions receive focused refinements.",
      },
    ],
  },
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
    kicker: "Pull requests and reliability fixes",
    headline: "Scient 0.6.1",
    summary:
      "This release adds pull-request tools and improves Codex sign-in, themes, and platform reliability.",
    highlights: [
      {
        id: "pull-requests",
        title: "Pull requests",
        description:
          "Browse and manage pull requests from GitHub, GitLab, Bitbucket, and Azure DevOps. View code and timelines, submit reviews, and create local checkouts.",
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
