import { getDomain } from "tldts";

export type PublisherArtworkCandidate = {
  readonly url: URL;
  readonly kind: "page" | "image";
  readonly publisher: string;
};

type PublisherArtwork = {
  readonly names: readonly string[];
  readonly publisher: string;
  readonly kind: "page" | "image";
  readonly url: string;
};

// These are publisher fallbacks, never evidence of a journal-specific logo.
const publisherArtwork: readonly PublisherArtwork[] = [
  {
    names: ["American Medical Association (AMA)"],
    publisher: "JAMA Network",
    kind: "image",
    url: "https://support.jamanetwork.com/hc/theming_assets/01JRG5VCDVTKSCCVH3VECC9GVF",
  },
  {
    names: ["Radiological Society of North America (RSNA)"],
    publisher: "Radiological Society of North America (RSNA)",
    kind: "page",
    url: "https://www.rsna.org/",
  },
  {
    names: ["Wiley"],
    publisher: "Wiley",
    kind: "page",
    url: "https://www.wiley.com/",
  },
  {
    names: [
      "Springer Nature",
      "Springer Science+Business Media",
      "Springer Science and Business Media LLC",
    ],
    publisher: "Springer Nature",
    kind: "page",
    url: "https://www.springernature.com/",
  },
  {
    names: ["BioMed Central"],
    publisher: "Springer Nature",
    kind: "image",
    url: "https://link.springer.com/oscar-static/img/favicons/darwin/favicon-de0c289efe.ico",
  },
  {
    names: ["Taylor & Francis"],
    publisher: "Taylor & Francis",
    kind: "page",
    url: "https://taylorandfrancis.com/",
  },
  {
    names: ["Routledge"],
    publisher: "Routledge",
    kind: "page",
    url: "https://www.routledge.com/",
  },
  {
    names: ["Institute of Electrical and Electronics Engineers", "IEEE"],
    publisher: "IEEE",
    kind: "page",
    url: "https://ieeeauthorcenter.ieee.org/",
  },
  {
    names: ["IEEE Computer Society"],
    publisher: "IEEE Computer Society",
    kind: "image",
    url: "https://www.computer.org/favicon.ico",
  },
  {
    names: ["American Chemical Society"],
    publisher: "American Chemical Society (ACS Publications)",
    kind: "page",
    url: "https://axial.acs.org/",
  },
  {
    names: ["Multidisciplinary Digital Publishing Institute"],
    publisher: "MDPI",
    kind: "image",
    url: "https://www.mdpi.com/favicon.ico",
  },
  {
    names: ["Royal Society of Chemistry"],
    publisher: "Royal Society of Chemistry",
    kind: "image",
    url: "https://blogs.rsc.org/favicon.ico",
  },
  {
    names: ["Elsevier BV"],
    publisher: "Elsevier",
    kind: "page",
    url: "https://www.elsevier.com/",
  },
  {
    names: ["IOP Publishing"],
    publisher: "IOP Publishing",
    kind: "page",
    url: "https://ioppublishing.org/",
  },
  {
    names: ["Institute of Physics"],
    publisher: "Institute of Physics",
    kind: "page",
    url: "https://www.iop.org/",
  },
  {
    names: ["SAGE Publishing"],
    publisher: "Sage",
    kind: "page",
    url: "https://www.sagepub.com/",
  },
  {
    names: ["Oxford University Press"],
    publisher: "Oxford University Press",
    kind: "page",
    url: "https://corp.oup.com/",
  },
  {
    names: ["Cambridge University Press"],
    publisher: "Cambridge University Press & Assessment",
    kind: "image",
    url: "https://www.cambridge.org/themes/custom/cupc/favicon.ico",
  },
  {
    names: ["American Physical Society"],
    publisher: "American Physical Society",
    kind: "image",
    url: "https://www.aps.org/favicon.ico",
  },
  {
    names: ["AIP Publishing"],
    publisher: "AIP Publishing",
    kind: "page",
    url: "https://publishing.aip.org/",
  },
  {
    names: ["American Institute of Physics"],
    publisher: "American Institute of Physics",
    kind: "image",
    url: "https://aip.brightspotcdn.com/fe/cb/baa748ae4d868d49228857e2b2af/logo-aip-dark-blue.svg",
  },
];

const artworkByPublisher = new Map(
  publisherArtwork.flatMap((artwork) =>
    artwork.names.map((name) => [name.toLowerCase(), artwork] as const),
  ),
);

const normalizePublisher = (value: string | null) =>
  (value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

// Exact publisher identities, not guesses from an article URL's parent domain.
const sitesByPublisher = new Map<string, readonly string[]>(
  publisherArtwork.flatMap((artwork) =>
    artwork.names.map(
      (name) =>
        [
          normalizePublisher(name),
          [getDomain(new URL(artwork.url).hostname, { allowPrivateDomains: true })!],
        ] as const,
    ),
  ),
);
for (const [names, sites] of [
  [
    [
      "Springer Nature",
      "Springer Science+Business Media",
      "Springer Science and Business Media LLC",
    ],
    ["nature.com", "springer.com"],
  ],
  [["Massachusetts Medical Society"], ["nejm.org"]],
  [["Association for Computational Linguistics"], ["aclanthology.org", "aclweb.org"]],
] as const) {
  for (const name of names) {
    const key = normalizePublisher(name);
    sitesByPublisher.set(key, [...(sitesByPublisher.get(key) ?? []), ...sites]);
  }
}

export function publisherControlsWebsite(
  record: { readonly publisher: string | null },
  url: URL,
): boolean {
  const domain = getDomain(url.hostname, { allowPrivateDomains: true });
  return (
    !!domain &&
    sitesByPublisher.get(normalizePublisher(record.publisher))?.includes(domain) === true
  );
}

export function venueArtworkCandidates(record: {
  readonly publisher: string | null;
  readonly containerTitle: string | null;
}): readonly PublisherArtworkCandidate[] {
  // Declared by the official NEJM AI store, not a general Society or Group logo.
  return normalizePublisher(record.publisher) === "massachusetts medical society" &&
    normalizePublisher(record.containerTitle) === "nejm ai"
    ? [
        {
          url: new URL("https://store.nejm.org/media/wysiwyg/NEJM-AI-logo-vs3.png"),
          kind: "image",
          publisher: "NEJM Group",
        },
      ]
    : [];
}

export function publisherArtworkCandidates(record: {
  readonly publisher: string | null;
}): readonly PublisherArtworkCandidate[] {
  const publisher = normalizePublisher(record.publisher);
  const artwork = artworkByPublisher.get(publisher);
  return artwork
    ? [{ url: new URL(artwork.url), kind: artwork.kind, publisher: artwork.publisher }]
    : [];
}
