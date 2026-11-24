import { act, render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesOverviewResult, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { I18nProvider } from "~/i18n/I18nProvider";
import { setI18nLanguage, startI18n } from "~/i18n/runtime";
import { ScientSourcesPanel } from "./ScientSourcesPanel";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  organize: vi.fn(),
  addByIdentifier: vi.fn(),
  menu: vi.fn(),
  fullText: vi.fn(async () => ({ hits: [], status: { pending: 0 } })),
}));
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  readScientSources: mocks.read,
  organizeScientSources: mocks.organize,
  addScientSourcesByIdentifier: mocks.addByIdentifier,
  searchScientSourcesFullText: mocks.fullText,
}));
vi.mock("../../localApi", async (original) => ({
  ...(await original<typeof import("../../localApi")>()),
  readLocalApi: () => ({ contextMenu: { show: mocks.menu } }),
}));
vi.mock("./sourcesCommands", async (original) => ({
  ...(await original<typeof import("./sourcesCommands")>()),
  useCanChangeLibrary: () => true,
  useCanRunSourcesCommand: () => true,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "environment-1",
  useEnvironment: () => ({ label: "This Mac" }),
}));
vi.mock("../accounts/useAccounts", () => ({
  useAccounts: () => ({ data: null }),
  useAccountCommand: () => vi.fn(async () => undefined),
}));
vi.mock("../accounts/University", () => ({ UniversityCrest: () => null }));
vi.mock("../accounts/PaperRequests", () => ({ PaperQueueBand: () => null }));
vi.mock("./useManagedBibliography", () => ({ useManagedBibliography: () => ({ status: null }) }));
vi.mock("./useLibraryMoveStatus", () => ({ useLibraryMoveStatus: () => ({ line: null }) }));
vi.mock("./ZoteroSync", () => ({ useZoteroSync: () => ({}), ZoteroRefreshDialog: () => null }));
vi.mock("../../hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));

type Overview = ScientSourcesOverviewResult;
type SourceRecord = Overview["records"][number];

function source(index: number, pinned: boolean): SourceRecord {
  return {
    sourceId: `source_${index}`,
    revision: 1,
    type: "article",
    title: `Measured outcomes of a long-running cohort study, part ${index + 1}`,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedYear: 2000 + (index % 25),
    identifiers: [],
    containerTitle: "Journal of Measurements and Long Observations",
    url: null,
    externalReferences: [],
    attachments: [],
    importedAt: new Date(Date.UTC(2026, 10, 1) - index * 1_000).toISOString(),
    pinned,
    readingStatus: index % 3 === 0 ? "unread" : "read",
    starred: index % 4 === 0,
  };
}

/** The Library holds `library` sources; the first `project` of them are in the project. */
function overview(project: number, library: number, scope: unknown): Overview {
  const listed = scope === "library" ? "library" : "project";
  const count = listed === "library" ? library : project;
  return {
    projectState: "initialized",
    issues: [],
    recordDiagnostics: [],
    activeOperation: null,
    scopes: { listed, project, library },
    records: Array.from({ length: count }, (_, index) => source(index, index < project)),
  };
}

function holding(project: number, library: number) {
  mocks.read
    .mockReset()
    .mockImplementation(async (_environment, _root, scope) => overview(project, library, scope));
}

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/u.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** A failure is a control that is cut off, covered or pushed outside the panel. */
function layoutProblems(panel: HTMLElement): string[] {
  const problems: string[] = [];
  const bounds = panel.getBoundingClientRect();
  const menus = [...document.querySelectorAll<HTMLElement>("[role='menu']")];
  const controls = [
    // An open menu covers the panel on purpose; then only the menu's own items count.
    ...(menus.length > 0
      ? []
      : panel.querySelectorAll<HTMLElement>(
          "button, a[href], input:not([type='file']):not([aria-hidden='true']), [role='button'], [role='tab'], [role='checkbox']",
        )),
    ...menus.flatMap((menu) => [
      ...menu.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemcheckbox']"),
    ]),
  ];
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const name = (control.getAttribute("aria-label") ?? control.textContent ?? "").trim();
    const label = `${control.tagName.toLowerCase()} "${name.slice(0, 40)}"`;
    // A control a scrolling area hides past its edge is reachable by scrolling.
    const scroller = scrollerOf(control)?.getBoundingClientRect();
    if (scroller && (rect.top < scroller.top - 0.5 || rect.bottom > scroller.bottom + 0.5)) {
      continue;
    }
    const box = panel.contains(control)
      ? bounds
      : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    if (
      rect.left < box.left - 0.5 ||
      rect.right > box.right + 0.5 ||
      rect.top < box.top - 0.5 ||
      rect.bottom > box.bottom + 0.5
    ) {
      problems.push(`${label} is outside its container`);
      continue;
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit && !control.contains(hit) && !hit.contains(control)) {
      const by = hit.getAttribute("aria-label") ?? hit.textContent?.trim().slice(0, 30) ?? "";
      problems.push(`${label} is covered by ${hit.tagName.toLowerCase()} "${by}"`);
    }
    const ellipsis = [control, ...control.querySelectorAll<HTMLElement>("*")].some(
      (element) => getComputedStyle(element).textOverflow === "ellipsis",
    );
    if (!ellipsis && control.tagName !== "INPUT" && control.scrollWidth > control.clientWidth + 1) {
      problems.push(`${label} cuts off its text`);
    }
    // A text field narrower than about ten letters hides what was typed.
    if (
      control.tagName === "INPUT" &&
      control.getAttribute("type") !== "checkbox" &&
      rect.width < 64
    ) {
      problems.push(`${label} is too narrow to read`);
    }
  }
  return problems;
}

/** Tabs through the first controls; each one keyboard focus reaches must show it. */
async function unseenFocus(panel: HTMLElement, steps: number): Promise<string[]> {
  const unseen: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    await userEvent.keyboard("{Tab}");
    const focused = document.activeElement as HTMLElement | null;
    if (!focused || !panel.contains(focused)) continue;
    // The ring, outline or field highlight may sit on the control or on the field around it.
    const around = [focused, focused.parentElement, focused.parentElement?.parentElement];
    const shown = around.some((element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return (
        style.outlineStyle !== "none" ||
        style.boxShadow !== "none" ||
        (element !== focused && style.backgroundColor !== "rgba(0, 0, 0, 0)")
      );
    });
    if (!shown) {
      unseen.push(focused.getAttribute("aria-label") ?? focused.textContent?.slice(0, 40) ?? "");
    }
  }
  return unseen;
}

function host(width: number, height: number) {
  const container = document.createElement("div");
  container.style.cssText = `width:${width}px;height:${height}px;display:flex;flex-direction:column;overflow:hidden;background:var(--background)`;
  return container;
}

const panel = (
  <I18nProvider>
    <ScientSourcesPanel
      environmentId={"environment-1" as EnvironmentId}
      threadId={"thread-1" as ThreadId}
      projectTitle="Test project"
      root="/project"
      onOpenPdf={() => {}}
    />
  </I18nProvider>
);

const WORDS = {
  en: {
    myLibrary: "My Library",
    moreSource: "More source actions",
    moreLibrary: "More Library actions",
    importSources: "Import sources",
    addByIdentifier: "Add by identifier",
    identifiers: "Identifiers to add",
    add: "Add",
    noMatches: "No matching sources were found.",
  },
  de: {
    myLibrary: "Meine Bibliothek",
    moreSource: "Weitere Quellenaktionen",
    moreLibrary: "Weitere Bibliotheksaktionen",
    importSources: "Quellen importieren",
    addByIdentifier: "Per Kennung hinzufügen",
    identifiers: "Hinzuzufügende Kennungen",
    add: "Hinzufügen",
    noMatches: "Keine passenden Quellen gefunden.",
  },
} as const;

// The narrowest Library sits beside the file tree; a short window leaves it little height.
const SIZES = [
  { name: "narrow", width: 256, height: 480 },
  { name: "normal", width: 480, height: 800 },
  { name: "full", width: 1200, height: 800 },
] as const;

describe.each(["en", "de"] as const)("Library panel layout (%s)", (language) => {
  describe.each(SIZES)("$name", (size) => {
    const words = WORDS[language];
    const open = async () => {
      startI18n();
      await setI18nLanguage(language);
      // A narrow Library sits in a wide window: controls keep their desktop size.
      await page.viewport(Math.max(size.width, 1280), size.height);
      const screen = await render(panel, {
        router: false,
        container: host(size.width, size.height),
      });
      return {
        screen,
        check: () => {
          const problems = layoutProblems(screen.container);
          expect(problems, problems.join("\n")).toEqual([]);
        },
        [Symbol.asyncDispose]: async () => {
          await screen[Symbol.asyncDispose]();
          localStorage.clear();
          await act(() => setI18nLanguage("en"));
        },
      };
    };

    it("loading", async () => {
      mocks.read.mockReset().mockReturnValue(new Promise(() => {}));
      await using opened = await open();
      const { screen, check } = opened;
      await expect.element(screen.getByRole("heading")).toBeVisible();
      check();
    });

    it("failed load", async () => {
      mocks.read.mockReset().mockRejectedValue(new Error("The Library folder could not be read."));
      await using opened = await open();
      const { screen, check } = opened;
      await expect.element(screen.getByText("The Library folder could not be read.")).toBeVisible();
      check();
    });

    it("empty Library", async () => {
      holding(0, 0);
      await using opened = await open();
      const { screen, check } = opened;
      await expect.element(screen.getByRole("heading").first()).toBeVisible();
      check();
    });

    it("empty project with a populated Library", async () => {
      holding(0, 12);
      await using opened = await open();
      const { screen, check } = opened;
      await expect.element(screen.getByRole("heading").first()).toBeVisible();
      check();
    });

    it("no filter matches", async () => {
      holding(12, 12);
      await using opened = await open();
      const { screen, check } = opened;
      const search = screen.getByRole("searchbox");
      await search.fill("no such paper anywhere");
      await expect.element(screen.getByText(words.noMatches)).toBeVisible();
      check();
    });

    it.each(["list", "cards"] as const)("populated %s layout and keyboard focus", async (view) => {
      holding(40, 40);
      await using opened = await open();
      const { screen, check } = opened;
      await expect.element(screen.getByText(/part 1$/u).first()).toBeVisible();
      const toggle = screen.getByRole("button", { name: /^Show as|^Als /u });
      if (
        (view === "cards") ===
        /cards|Karten/u.test(toggle.element().getAttribute("aria-label") ?? "")
      ) {
        await toggle.click();
      }
      await expect
        .poll(() => screen.container.querySelector("[data-source-card]") !== null)
        .toBe(view === "cards");
      check();
      expect(await unseenFocus(screen.container, 14)).toEqual([]);
    });

    it("selection with the bulk bar, All Library", async () => {
      holding(0, 12);
      mocks.menu.mockReset().mockResolvedValue("select");
      await using opened = await open();
      const { screen, check } = opened;
      await screen.getByRole("button", { name: words.myLibrary, exact: true }).click();
      await expect.element(screen.getByText(/part 1$/u).first()).toBeVisible();
      await screen.getByRole("button", { name: words.moreSource }).nth(4).click();
      await expect.element(screen.getByText(/^1 /u)).toBeVisible();
      check();
    });

    it("open Library menu", async () => {
      holding(3, 3);
      await using opened = await open();
      const { screen, check } = opened;
      await expect.element(screen.getByText(/part 1$/u).first()).toBeVisible();
      await screen.getByRole("button", { name: words.moreLibrary }).click();
      await expect.element(page.getByRole("menu")).toBeVisible();
      check();
      await userEvent.keyboard("{Escape}");
    });

    it("import result and Activity", async () => {
      holding(3, 3);
      mocks.addByIdentifier.mockReset().mockResolvedValue({
        results: [
          {
            input: "10.1000/abc.123",
            identifier: { scheme: "doi", value: "10.1000/abc.123" },
            outcome: "imported",
            sourceId: "source_new",
            title: "Measured outcomes",
            verification: "verified",
            message: null,
          },
        ],
      });
      await using opened = await open();
      const { screen, check } = opened;
      await expect.element(screen.getByText(/part 1$/u).first()).toBeVisible();
      await screen.getByRole("button", { name: words.importSources }).click();
      await page.getByRole("menuitem", { name: words.addByIdentifier }).click();
      await page.getByRole("textbox", { name: words.identifiers }).fill("10.1000/abc.123");
      await page.getByRole("button", { name: words.add, exact: true }).click();
      await expect.element(screen.getByRole("status").first()).toBeVisible();
      check();
    });
  });
});

describe("Library panel large-list reachability", () => {
  it.each(["list", "cards"] as const)(
    "20,000 sources as %s reaches the actual last source",
    async (view) => {
      holding(20_000, 20_000);
      startI18n();
      await setI18nLanguage("en");
      await page.viewport(1280, 800);
      await using screen = await render(panel, {
        router: false,
        container: host(480, 800),
      });
      await expect.element(screen.getByText(/part 1$/u).first()).toBeVisible();
      const toggle = screen.getByRole("button", { name: /^Show as/u });
      if ((view === "cards") === /cards/u.test(toggle.element().getAttribute("aria-label") ?? "")) {
        await toggle.click();
      }
      await expect
        .poll(() => screen.container.querySelector("[data-source-card]") !== null)
        .toBe(view === "cards");
      const first = screen
        .getByText(/part 1$/u)
        .first()
        .element() as HTMLElement;
      const scroller = scrollerOf(first)!;
      await vi.waitFor(() => {
        scroller.scrollTop = scroller.scrollHeight;
        expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(
          scroller.scrollHeight - 1,
        );
        const bounds = scroller.getBoundingClientRect();
        const last = [...scroller.querySelectorAll<HTMLElement>("button")].find((button) =>
          button.textContent?.includes("part 20000"),
        );
        expect(last).toBeDefined();
        const rect = last!.getBoundingClientRect();
        expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 0.5);
        const hit = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
        expect(last!.contains(hit)).toBe(true);
      });
      localStorage.clear();
    },
  );
});
