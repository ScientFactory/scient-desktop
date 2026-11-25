import "../../index.css";

import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarThreadRow } from "./SidebarThreadRow";

const state = vi.hoisted(() => ({ computers: 1 }));

vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentIdentities: (() =>
    Array.from({ length: state.computers }, (_, index) => ({
      environmentId: EnvironmentId.make(`computer-${index}`),
      label: `Computer ${index}`,
    }))) as never,
}));

function setup({ computers }: { computers: number }) {
  state.computers = computers;
}

const noop = () => {};

const issue: ThreadIssueLink = {
  projectId: ProjectId.make("project-test"),
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "WEB",
  key: "WEB-123",
  url: "https://linear.app/example/issue/WEB-123/fit-spectra",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00.000Z",
  displayKey: "#123",
  title: "Fit spectra",
};

type Variant = "card" | "folder-multiline";

function Card({
  variant = "card",
  issues = [],
}: {
  variant?: Variant;
  issues?: ReadonlyArray<ThreadIssueLink>;
}) {
  return (
    <div data-slot="scroll-area-viewport" style={{ height: 400, width: 320, overflow: "auto" }}>
      <ul>
        <SidebarThreadRow
          thread={{ ...makeThreadFixture({ title: "Spectra fit" }), issues: [...issues] }}
          variant={variant}
          variantAction="settle"
          settlementSupported
          snoozeSupported
          pinningSupported
          isPinned={false}
          dropVerb={null}
          dragOverPinned={false}
          sweepAction={null}
          snoozeWakeLabelText={null}
          wokeAt={null}
          // An active row always renders in full, so the card is there to read.
          isActive
          isRouteThread={false}
          readOpensPullRequestsInRightPanel={() => false}
          jumpLabel={null}
          environmentLabel="Lab server"
          environmentMachine="server"
          project={null}
          projectDisplayName={null}
          providerEntryByInstanceId={new Map()}
          timestampFormat="locale"
          snoozeNow="2026-11-25T12:00:00.000Z"
          onThreadClick={noop}
          onThreadActivate={noop}
          onStartRename={noop}
          onRenameTitleChange={noop}
          onCommitRename={noop}
          onCancelRename={noop}
          isRenaming={false}
          renamingTitle=""
          onContextMenu={noop}
          onSettle={noop}
          onActionSweepStart={noop}
          onUnsettle={noop}
          onSnooze={noop}
          onUnsnooze={noop}
          onUnpin={noop}
          onAcknowledgeWoke={noop}
        />
      </ul>
    </div>
  );
}

// A folder row's body promises this height to rows scrolled out of view
// (contain-intrinsic-size), so a row that renders shorter throws off revealing the open thread.
function folderRowHeight(container: HTMLElement) {
  return container
    .querySelector<HTMLElement>('[class*="contain-intrinsic-size:auto_--spacing(13.5)"]')
    ?.getBoundingClientRect().height;
}

it.for<Variant>(["card", "folder-multiline"])(
  "marks a %s row's computer with its icon alone when there are several computers",
  async (variant) => {
    setup({ computers: 2 });
    await using screen = await render(<Card variant={variant} />);
    await expect.element(screen.getByText("Spectra fit")).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "Lab server" })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Lab server");
    // The line keeps a text line's height without the name.
    const line = screen.getByRole("img", { name: "Lab server" }).element().parentElement;
    expect(line?.getBoundingClientRect().height).toBe(16);
    if (variant === "folder-multiline") expect(folderRowHeight(screen.container)).toBe(54);
  },
);

it("keeps a folder row with only a marker at its promised height", async () => {
  setup({ computers: 1 });
  await using screen = await render(<Card variant="folder-multiline" issues={[issue]} />);
  await expect.element(screen.getByText("Spectra fit")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Issue #123: Fit spectra" }))
    .toBeVisible();
  expect(screen.container.querySelector('[aria-label="Lab server"]')).toBeNull();
  expect(folderRowHeight(screen.container)).toBe(54);
});

it("leaves a card's computer out when there is only one", async () => {
  setup({ computers: 1 });
  await using screen = await render(<Card />);
  await expect.element(screen.getByText("Spectra fit")).toBeVisible();
  expect(screen.container.querySelector('[aria-label="Lab server"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("Lab server");
});
