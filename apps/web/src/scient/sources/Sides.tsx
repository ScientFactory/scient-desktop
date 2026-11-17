/** Two values side by side: the one here, and the other's. */
export function Sides(props: {
  readonly label: string;
  readonly other: string;
  readonly here: string;
  readonly hereName: string;
  readonly otherName: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{props.label}</p>
        {props.children}
      </div>
      <dl className="mt-1 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{props.hereName}</dt>
          <dd className="break-words whitespace-pre-wrap">{props.here || "(none)"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{props.otherName}</dt>
          <dd className="break-words whitespace-pre-wrap">{props.other || "(none)"}</dd>
        </div>
      </dl>
    </div>
  );
}
