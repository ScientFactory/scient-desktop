import type { RecordingSession, RecordingSessionMaterial } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { randomUUID } from "../../lib/utils";
import { RecordingSelect } from "./RecordingSelect";
import { recordingTime } from "./recordingPresentation";

export function SessionMaterial({
  session,
  moment,
  pending,
  onChange,
  onSeek,
}: {
  session: RecordingSession;
  moment: RecordingSessionMaterial["moment"];
  pending: boolean;
  onChange: (material: readonly RecordingSessionMaterial[]) => Promise<boolean>;
  onSeek: (recordingId: string, time: number) => void;
}) {
  const gt = useGT();
  const [source, setSource] = useState<RecordingSessionMaterial["source"]>("project");
  const [reference, setReference] = useState("");
  const [name, setName] = useState("");
  const [pages, setPages] = useState("");
  const [linkMoment, setLinkMoment] = useState(false);
  const add = async () => {
    const path = reference.trim();
    const range = pages.trim();
    if (!path || (range && !/^\d+(?:-\d+)?$/.test(range))) return;
    if (
      await onChange([
        ...session.material,
        {
          id: randomUUID(),
          name: (name.trim() || path.split(/[/\\]/).at(-1) || path).slice(0, 200),
          source,
          reference: path,
          included: true,
          ...(range ? { pages: range } : {}),
          ...(linkMoment && moment ? { moment } : {}),
        },
      ])
    ) {
      setReference("");
      setName("");
      setPages("");
    }
  };
  return (
    <section className="space-y-4">
      {session.material.length ? (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {session.material.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <Checkbox
                checked={item.included}
                disabled={pending}
                aria-label={gt("Include {name} in notes and chat", { name: item.name })}
                onCheckedChange={(included) =>
                  void onChange(
                    session.material.map((entry) =>
                      entry.id === item.id ? { ...entry, included: included === true } : entry,
                    ),
                  )
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.reference}{" "}
                  {item.pages ? `· ${gt("Pages {range}", { range: item.pages })}` : ""}
                </p>
              </div>
              {item.moment && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onSeek(item.moment!.recordingId, item.moment!.time)}
                >
                  {recordingTime(item.moment.time)}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void onChange(session.material.filter(({ id }) => id !== item.id))}
              >
                {gt("Unlink")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {gt("Link slides, project files or Library sources to use in notes and chat.")}
        </p>
      )}
      <form
        className="space-y-2 rounded-lg border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <RecordingSelect
            label={gt("Material source")}
            value={source}
            variant="outline"
            options={[
              { value: "project", label: gt("Project file") },
              { value: "library", label: gt("Library source") },
            ]}
            onChange={(value) => setSource(value === "library" ? "library" : "project")}
          />
          <div className="min-w-44 flex-1">
            <Input
              size="sm"
              aria-label={
                source === "project" ? gt("Project-relative file path") : gt("Library source ID")
              }
              placeholder={
                source === "project" ? gt("Project-relative file path") : gt("Library source ID")
              }
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-40 flex-1">
            <Input
              size="sm"
              aria-label={gt("Name")}
              placeholder={gt("Name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="w-32">
            <Input
              size="sm"
              aria-label={gt("Page range")}
              placeholder={gt("Pages")}
              value={pages}
              onChange={(event) => setPages(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={
              pending ||
              !reference.trim() ||
              (pages.trim() !== "" && !/^\d+(?:-\d+)?$/.test(pages.trim()))
            }
          >
            {gt("Link material")}
          </Button>
        </div>
        {moment && (
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={linkMoment}
              onCheckedChange={(checked) => setLinkMoment(checked === true)}
            />
            {gt("Link to this moment")}
          </label>
        )}
      </form>
    </section>
  );
}
