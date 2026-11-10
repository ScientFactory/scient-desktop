import type { ScientPrismaCounts } from "@scientfactory/scient-sources";
import { ArrowDown, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

function Box(props: {
  readonly title: string;
  readonly count: number;
  readonly children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs">
      <p className="text-foreground">
        {props.title}{" "}
        <span className="tabular-nums text-muted-foreground">(n = {props.count})</span>
      </p>
      {props.children ? (
        <ul className="mt-1 space-y-0.5 text-muted-foreground">{props.children}</ul>
      ) : null}
    </div>
  );
}

function Line(props: { readonly label: string; readonly count: number }) {
  return (
    <li>
      {props.label} <span className="tabular-nums">(n = {props.count})</span>
    </li>
  );
}

function Down() {
  return (
    <div className="flex justify-center text-muted-foreground/70" aria-hidden="true">
      <ArrowDown className="size-3.5" />
    </div>
  );
}

function Row(props: { readonly main: ReactNode; readonly side?: ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      {props.main}
      {props.side ? (
        <ArrowRight className="size-3.5 text-muted-foreground/70" aria-hidden="true" />
      ) : (
        <span />
      )}
      {props.side ?? <span />}
    </div>
  );
}

/** The PRISMA 2020 flow for one review, drawn from the same counts agents read. */
export function PrismaDiagram(props: { readonly prisma: ScientPrismaCounts }) {
  const { prisma } = props;
  const awaitingScreening = prisma.titleAbstract.pending + prisma.titleAbstract.maybe;
  const awaitingAssessment = prisma.fullText.pending + prisma.fullText.maybe;
  return (
    <figure className="space-y-1.5" aria-label="PRISMA flow diagram">
      <Row
        main={
          <Box
            title="Records identified"
            count={prisma.identified.databases + prisma.identified.otherMethods}
          >
            {prisma.identified.byDatabase.map((entry) => (
              <Line key={entry.database} label={entry.database} count={entry.count} />
            ))}
            {prisma.identified.otherMethods > 0 ? (
              <Line label="Other methods" count={prisma.identified.otherMethods} />
            ) : null}
          </Box>
        }
        side={
          <Box
            title="Removed before screening"
            count={prisma.removedBeforeScreening.duplicates + prisma.removedBeforeScreening.other}
          >
            <Line label="Duplicates" count={prisma.removedBeforeScreening.duplicates} />
            {prisma.removedBeforeScreening.other > 0 ? (
              <Line label="Other reasons" count={prisma.removedBeforeScreening.other} />
            ) : null}
          </Box>
        }
      />
      <Down />
      <Row
        main={
          <Box title="Records screened" count={prisma.screened}>
            {awaitingScreening > 0 ? (
              <Line label="Awaiting screening" count={awaitingScreening} />
            ) : null}
          </Box>
        }
        side={<Box title="Records excluded" count={prisma.titleAbstract.excluded} />}
      />
      <Down />
      <Row
        main={
          <Box title="Reports sought for retrieval" count={prisma.retrieval.sought}>
            {prisma.retrieval.pending > 0 ? (
              <Line label="Awaiting retrieval" count={prisma.retrieval.pending} />
            ) : null}
          </Box>
        }
        side={<Box title="Reports not retrieved" count={prisma.retrieval.notRetrieved} />}
      />
      <Down />
      <Row
        main={
          <Box title="Reports assessed for eligibility" count={prisma.fullText.assessed}>
            {awaitingAssessment > 0 ? (
              <Line label="Awaiting assessment" count={awaitingAssessment} />
            ) : null}
          </Box>
        }
        side={
          <Box title="Reports excluded" count={prisma.fullText.excluded}>
            {prisma.fullText.excludedByReason.map((entry) => (
              <Line key={entry.reason} label={entry.reason} count={entry.count} />
            ))}
          </Box>
        }
      />
      <Down />
      <Row main={<Box title="Studies included in review" count={prisma.included} />} />
    </figure>
  );
}
