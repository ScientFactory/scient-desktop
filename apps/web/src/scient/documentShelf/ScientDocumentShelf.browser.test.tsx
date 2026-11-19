import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  ScientDocumentShelf,
  ShelfItem,
  useChangesWhileShown,
  useShelfPlace,
} from "./ScientDocumentShelf";

/** A document view that counts its mounts and, when `keeps`, asks the shelf to keep it hidden. */
function View(props: {
  readonly name: string;
  readonly keeps: boolean;
  readonly mounts: string[];
  readonly evicts?: Map<string, () => void>;
}) {
  const place = useShelfPlace();
  const { name, keeps, mounts, evicts } = props;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) mounts.push(name);
    mounted.current = true;
    if (!keeps) return;
    return place?.keep({
      hide: (evict) => {
        evicts?.set(name, evict);
        return true;
      },
      show: () => undefined,
    });
  }, [name, keeps, mounts, evicts, place]);
  return <p data-name={name}>{name}</p>;
}

const shelf = (child: React.ReactNode) => <ScientDocumentShelf>{child}</ScientDocumentShelf>;
const item = (name: string, props: Omit<Parameters<typeof View>[0], "name">) => (
  <ShelfItem shelfKey={name}>
    <View name={name} {...props} />
  </ShelfItem>
);

describe("ScientDocumentShelf", () => {
  it("shows a document left recently as it was left, without mounting it again", async () => {
    const mounts: string[] = [];
    await using screen = await render(shelf(item("a.pdf", { keeps: true, mounts })));
    const view = screen.container.querySelector('[data-name="a.pdf"]')!;
    await screen.rerender(shelf(<p>notes.md</p>));
    // Hidden in place: not seen, not reachable, same size.
    const place = view.parentElement!;
    expect(place.style.visibility).toBe("hidden");
    expect(place.inert).toBe(true);
    await screen.rerender(shelf(item("a.pdf", { keeps: true, mounts })));
    expect(screen.container.querySelector('[data-name="a.pdf"]')).toBe(view);
    expect(place.style.visibility).toBe("");
    expect(mounts).toEqual(["a.pdf"]);
  });

  it("lets a view go when its reader does not keep it, or asks it to go", async () => {
    const mounts: string[] = [];
    const evicts = new Map<string, () => void>();
    await using screen = await render(shelf(item("loose.pdf", { keeps: false, mounts })));
    await screen.rerender(shelf(item("kept.docx", { keeps: true, mounts, evicts })));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-name="loose.pdf"]')).toBeNull(),
    );
    await screen.rerender(shelf(<p>notes.md</p>));
    expect(screen.container.querySelector('[data-name="kept.docx"]')).not.toBeNull();
    evicts.get("kept.docx")!();
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-name="kept.docx"]')).toBeNull(),
    );
    await screen.rerender(shelf(item("kept.docx", { keeps: true, mounts, evicts })));
    expect(mounts).toEqual(["loose.pdf", "kept.docx", "kept.docx"]);
  });
});

// regression: reloading one file remounted the hidden view of another when it showed again.
describe("useChangesWhileShown", () => {
  function Probe(props: { readonly file: string; readonly reloads: number }) {
    return <p>{`${props.file}:${useChangesWhileShown(props.file, String(props.reloads))}`}</p>;
  }

  it("counts a reload only for the file shown when it was asked", async () => {
    await using screen = await render(<Probe file="a" reloads={0} />);
    await screen.rerender(<Probe file="b" reloads={0} />);
    await screen.rerender(<Probe file="b" reloads={1} />);
    expect(screen.container.textContent).toBe("b:1");
    await screen.rerender(<Probe file="a" reloads={1} />);
    expect(screen.container.textContent).toBe("a:0");
  });
});
