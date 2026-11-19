/* oxlint-disable react/no-array-index-key -- A slide's spans keep their order while it is shown. */
import { Fragment, useEffect, useState } from "react";

import { layerFont, lineHeight, type WordSpan } from "~/components/files/office/word-protocol";

/**
 * A slide's text, transparent over its painted glyphs, so it can be selected, copied, found and
 * quoted as a Word page's can. Laid out like the Word text layer, in units of the slide's width.
 */
export function SlideTextLayer(props: {
  readonly index: number;
  readonly text: (index: number, signal: AbortSignal) => Promise<readonly WordSpan[]>;
}) {
  const { index, text } = props;
  const [spans, setSpans] = useState<readonly WordSpan[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests the slide's text from the deck's worker and cancels the request when the slide leaves the view
  useEffect(() => {
    const controller = new AbortController();
    void text(index, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setSpans(next);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [index, text]);
  return (
    <div
      className="absolute inset-0 select-text overflow-hidden whitespace-pre text-transparent selection:bg-primary/30 selection:text-transparent"
      style={{ containerType: "inline-size", fontFamily: layerFont, fontSize: 0, lineHeight }}
    >
      {spans.map((span, at) => (
        <Fragment key={at}>
          <span
            dir={span.dir}
            className="absolute origin-top-left cursor-text"
            style={{
              left: `${span.left * 100}%`,
              top: `${span.top * 100}%`,
              fontSize: `${span.size * 100}cqw`,
              transform: span.transform,
            }}
          >
            {span.text}
          </span>
          {span.after === "br" ? <br /> : null}
        </Fragment>
      ))}
    </div>
  );
}
