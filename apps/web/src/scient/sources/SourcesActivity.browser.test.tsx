import "~/index.css";
import { useEffect, useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { selectSourcesActivity, type SourcesActivityItem } from "./sourcesFeedback";
import {
  SourcesActivityButton,
  SourcesResultSlot,
  useSourcesResult,
  type SourcesResultControls,
} from "./SourcesActivity";

function Harness(props: {
  readonly context: string;
  readonly items: ReadonlyArray<SourcesActivityItem>;
  readonly onSlot: (slot: SourcesResultControls) => void;
}) {
  const slot = useSourcesResult(props.context);
  const [open, setOpen] = useState(false);
  const { onSlot } = props;
  useEffect(() => onSlot(slot), [onSlot, slot]);
  return (
    <>
      <SourcesResultSlot
        result={slot.result}
        onDetails={() => setOpen(true)}
        onDismiss={slot.dismiss}
      />
      <SourcesActivityButton
        activity={selectSourcesActivity(props.items)}
        result={slot.result}
        open={open}
        onOpenChange={setOpen}
        onDismissResult={slot.dismiss}
      />
    </>
  );
}

const choice: SourcesActivityItem = {
  key: "bibliography",
  tone: "decision",
  label: "references.bib was edited outside Scient",
  body: <p>references.bib was edited outside Scient.</p>,
};

it("keeps a choice that needs the person in Activity when the result is dismissed", async () => {
  const probe: { current: SourcesResultControls | null } = { current: null };
  const onSlot = (slot: SourcesResultControls) => {
    probe.current = slot;
  };
  await using screen = await render(<Harness context="a" items={[choice]} onSlot={onSlot} />);
  await act(async () => {
    const operationId = probe.current!.begin();
    probe.current!.settle(operationId, {
      tone: "error",
      summary: "The import stopped part way.",
      details: <p>3 references could not be read.</p>,
    });
  });
  await expect.element(screen.getByText("The import stopped part way.")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Details" }));
  const dialog = page.getByRole("dialog", { name: "Activity" });
  await expect.element(dialog.getByText("3 references could not be read.")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Dismiss" }));

  await expect.element(dialog.getByText("3 references could not be read.")).not.toBeInTheDocument();
  await expect
    .element(
      dialog
        .getByRole("region", { name: "Needs you" })
        .getByText("references.bib was edited outside Scient."),
    )
    .toBeVisible();
  // Closing the dialog only closes the view: the choice is still counted.
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByText("The import stopped part way.")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Activity: 1" })).toBeVisible();
});

it("drops the result on a change of project, also when an older operation ends later", async () => {
  const probe: { current: SourcesResultControls | null } = { current: null };
  const onSlot = (slot: SourcesResultControls) => {
    probe.current = slot;
  };
  await using screen = await render(<Harness context="a" items={[]} onSlot={onSlot} />);
  let running = "";
  await act(async () => {
    const first = probe.current!.begin();
    probe.current!.settle(first, { tone: "success", summary: "Added 1 source." });
  });
  await expect.element(screen.getByText("Added 1 source.")).toBeVisible();
  // A newer start clears what was shown, before it has a result of its own.
  await act(async () => {
    running = probe.current!.begin();
  });
  await expect.element(screen.getByText("Added 1 source.")).not.toBeInTheDocument();

  await screen.rerender(<Harness context="b" items={[]} onSlot={onSlot} />);
  let shown = true;
  await act(async () => {
    shown = probe.current!.settle(running, { tone: "success", summary: "6 references imported." });
  });
  expect(shown).toBe(false);
  await expect.element(screen.getByText("6 references imported.")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /^Activity/u })).not.toBeInTheDocument();
});
