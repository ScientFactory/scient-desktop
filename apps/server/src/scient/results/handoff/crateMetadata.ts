import type { ResultHandoffManifest } from "@t3tools/contracts";

import { includedDataPath } from "./handoffFiles.ts";

const RO_CRATE = "https://w3id.org/ro/crate/1.3";
const PROCESS_RUN = "https://w3id.org/ro/wfrun/process/0.6";
const ref = (id: string) => ({ "@id": id });
const fileId = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function crateMetadata(
  manifest: Omit<ResultHandoffManifest, "documentation">,
  sizes: ReadonlyMap<string, number>,
) {
  const source = fileId(`source/${manifest.source.path}`);
  const makeFile = (name: string, path: string, size = sizes.get(path)) => ({
    ...ref(fileId(path)),
    "@type": "File",
    name,
    ...(path === name ? {} : { alternateName: name }),
    ...(size === undefined ? {} : { contentSize: String(size) }),
  });
  const inputs = manifest.inputs.map((input, index) =>
    input.included
      ? makeFile(input.path, includedDataPath(input.path, manifest.version), input.size)
      : {
          ...ref(`#external-input-${index + 1}`),
          "@type": "File",
          name: input.path,
          contentSize: String(input.size),
          description: "Input referenced by the manifest and supplied separately.",
        },
  );
  const parameters = (manifest.parameters ?? []).map((parameter, index) => ({
    ...ref(`#parameter-${index + 1}`),
    "@type": "PropertyValue",
    name: parameter.name,
    value: parameter.value,
  }));
  const outputs = manifest.outputs
    .filter((output) => !output.pruned)
    .map((output) => ({
      ...makeFile(output.name, `outputs/${output.name}`, output.size),
      encodingFormat: output.mediaType,
    }));
  const environment = manifest.environment.lockfiles
    .filter((file) => file.included)
    .map((file) => makeFile(file.path, `environment/lockfiles/${file.path}`));
  const code = (manifest.code ?? []).map((file) => ({
    ...makeFile(file.path, `source/${file.path}`, file.size),
    "@type": ["File", "SoftwareSourceCode"],
  }));
  const files = [
    {
      ...makeFile(manifest.source.path, `source/${manifest.source.path}`, manifest.source.size),
      "@type": ["File", "SoftwareSourceCode"],
    },
    ...code,
    ...inputs.filter((_input, index) => manifest.inputs[index]?.included === true),
    ...outputs,
    ...environment,
    ...(manifest.environment.packageListSha256 === undefined
      ? []
      : [makeFile("Installed packages", "environment/packages.json")]),
    ...(manifest.license === undefined
      ? []
      : [
          {
            ...makeFile("LICENSE", "LICENSE", manifest.license.size),
            "@type": ["File", "CreativeWork"],
          },
        ]),
    makeFile("README.md", "README.md"),
    makeFile("manifest.json", "manifest.json"),
  ];
  return {
    "@context": [`${RO_CRATE}/context`, "https://w3id.org/ro/terms/workflow-run/context"],
    "@graph": [
      {
        ...ref("ro-crate-metadata.json"),
        "@type": "CreativeWork",
        conformsTo: ref(RO_CRATE),
        about: ref("./"),
      },
      {
        ...ref("./"),
        "@type": "Dataset",
        name: "Scient result package",
        description: "Source, results and provenance for one run.",
        datePublished: manifest.createdAt,
        conformsTo: ref(PROCESS_RUN),
        hasPart: files.map((file) => ref(file["@id"])),
        mentions: ref("#run"),
        ...(manifest.license === undefined ? {} : { license: ref("LICENSE") }),
      },
      { ...ref(PROCESS_RUN), "@type": "CreativeWork", name: "Process Run Crate", version: "0.6" },
      {
        ...ref("#runtime"),
        "@type": "SoftwareApplication",
        name: manifest.source.language,
        ...(manifest.runtime.version === null ? {} : { softwareVersion: manifest.runtime.version }),
      },
      {
        ...ref("#run"),
        "@type": "CreateAction",
        name: "Run the analysis",
        instrument: [ref("#runtime"), ref(source)],
        object: [
          ref(source),
          ...[...code, ...inputs, ...environment, ...parameters].map((file) => ref(file["@id"])),
        ],
        result: outputs.map((file) => ref(file["@id"])),
        ...(manifest.run.startedAt === null ? {} : { startTime: manifest.run.startedAt }),
        endTime: manifest.run.finishedAt,
      },
      ...files,
      ...parameters,
      ...inputs.filter((_input, index) => manifest.inputs[index]?.included !== true),
    ],
  };
}
