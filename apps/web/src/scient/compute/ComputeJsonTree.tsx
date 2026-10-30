import { cn } from "~/lib/utils";

const MAX_CHILDREN = 200;

function Scalar(props: { readonly value: unknown }) {
  const { value } = props;
  return (
    <span
      className={cn(
        typeof value === "string" && "text-green-700 dark:text-green-400",
        typeof value === "number" && "text-blue-600 dark:text-blue-400",
        (typeof value === "boolean" || value === null) && "text-fuchsia-600 dark:text-fuchsia-400",
      )}
    >
      {JSON.stringify(value)}
    </span>
  );
}

function JsonNode(props: { readonly name: string | null; readonly value: unknown; readonly open: boolean }) {
  const { value } = props;
  const label =
    props.name === null ? null : <span className="text-muted-foreground">{props.name}: </span>;
  if (value === null || typeof value !== "object") {
    return (
      <div className="ps-4">
        {label}
        <Scalar value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <details open={props.open} className="ps-4 [&>summary]:-ms-4">
      <summary className="cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {label}
        <span className="text-muted-foreground">{summary}</span>
      </summary>
      {entries.slice(0, MAX_CHILDREN).map(([name, child]) => (
        <JsonNode key={name} name={name} value={child} open={false} />
      ))}
      {entries.length > MAX_CHILDREN ? (
        <div className="ps-4 text-muted-foreground">… {entries.length - MAX_CHILDREN} more</div>
      ) : null}
    </details>
  );
}

/** A compact, collapsed-by-default view of a JSON result; the root level starts open. */
export function ComputeJsonTree(props: { readonly value: unknown }) {
  return (
    <div className="-ms-4 font-mono text-xs leading-relaxed">
      <JsonNode name={null} value={props.value} open />
    </div>
  );
}
