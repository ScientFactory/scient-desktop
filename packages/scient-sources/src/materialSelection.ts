import type { ScientSourceAttachment } from "./model.ts";

export type ScientSourceMaterialSupport = {
  readonly kind: string;
  readonly mediaType: string;
};

export const SCIENT_SOURCE_PDF_MATERIAL_SUPPORT = [
  { kind: "pdf", mediaType: "application/pdf" },
] as const satisfies ReadonlyArray<ScientSourceMaterialSupport>;

export type ScientSourceMaterialReference = Pick<
  ScientSourceAttachment,
  "attachmentId" | "kind" | "mediaType"
>;

export type ScientSourceMaterialSelection<
  Material extends ScientSourceMaterialReference = ScientSourceAttachment,
> =
  | {
      readonly _tag: "Selected";
      readonly material: Material;
      readonly selectedBy: "requested-id" | "single-eligible-material";
    }
  | { readonly _tag: "NoMaterial" }
  | {
      readonly _tag: "MaterialNotFound";
      readonly requestedAttachmentId: string;
    }
  | {
      readonly _tag: "UnsupportedMaterial";
      readonly materials: ReadonlyArray<Material>;
    }
  | {
      readonly _tag: "SeveralMaterials";
      readonly materials: ReadonlyArray<Material>;
    }
  | {
      readonly _tag: "DuplicateMaterialId";
      readonly attachmentId: string;
    };

function supportsMaterial(
  material: ScientSourceMaterialReference,
  supportedMaterials: ReadonlyArray<ScientSourceMaterialSupport>,
): boolean {
  return supportedMaterials.some(
    (support) => support.kind === material.kind && support.mediaType === material.mediaType,
  );
}

function duplicateMaterialId(
  materials: ReadonlyArray<ScientSourceMaterialReference>,
): string | null {
  const seen = new Set<string>();
  for (const material of materials) {
    if (seen.has(material.attachmentId)) return material.attachmentId;
    seen.add(material.attachmentId);
  }
  return null;
}

/**
 * Selects one concrete Source material without assigning meaning to array
 * order. Multiple eligible materials require an explicit stable ID.
 */
export function selectScientSourceMaterial<Material extends ScientSourceMaterialReference>(input: {
  readonly materials: ReadonlyArray<Material>;
  readonly requestedAttachmentId?: string;
  readonly supportedMaterials?: ReadonlyArray<ScientSourceMaterialSupport>;
}): ScientSourceMaterialSelection<Material> {
  const duplicateId = duplicateMaterialId(input.materials);
  if (duplicateId !== null) {
    return { _tag: "DuplicateMaterialId", attachmentId: duplicateId };
  }

  if (input.materials.length === 0) return { _tag: "NoMaterial" };

  const supportedMaterials = input.supportedMaterials ?? SCIENT_SOURCE_PDF_MATERIAL_SUPPORT;
  if (input.requestedAttachmentId !== undefined) {
    const requested = input.materials.find(
      (material) => material.attachmentId === input.requestedAttachmentId,
    );
    if (!requested) {
      return {
        _tag: "MaterialNotFound",
        requestedAttachmentId: input.requestedAttachmentId,
      };
    }
    if (!supportsMaterial(requested, supportedMaterials)) {
      return { _tag: "UnsupportedMaterial", materials: [requested] };
    }
    return { _tag: "Selected", material: requested, selectedBy: "requested-id" };
  }

  const eligible = input.materials.filter((material) =>
    supportsMaterial(material, supportedMaterials),
  );
  if (eligible.length === 0) {
    return { _tag: "UnsupportedMaterial", materials: input.materials };
  }
  if (eligible.length > 1) return { _tag: "SeveralMaterials", materials: eligible };
  return {
    _tag: "Selected",
    material: eligible[0]!,
    selectedBy: "single-eligible-material",
  };
}

export type ScientSourceMaterialBytes =
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Available";
      readonly sha256: string;
      readonly byteLength: number;
    };

export type ScientSourceMaterialVerification =
  | {
      readonly _tag: "Verified";
      readonly material: ScientSourceAttachment;
    }
  | {
      readonly _tag: "MissingBytes";
      readonly material: ScientSourceAttachment;
    }
  | {
      readonly _tag: "HashMismatch";
      readonly material: ScientSourceAttachment;
      readonly observedSha256: string;
    }
  | {
      readonly _tag: "ByteLengthMismatch";
      readonly material: ScientSourceAttachment;
      readonly observedByteLength: number;
    };

/** Applies adapter-observed byte identity without choosing another material. */
export function verifyScientSourceMaterial(
  material: ScientSourceAttachment,
  bytes: ScientSourceMaterialBytes,
): ScientSourceMaterialVerification {
  if (bytes._tag === "Missing") return { _tag: "MissingBytes", material };
  if (bytes.sha256.trim().toLowerCase() !== material.sha256.trim().toLowerCase()) {
    return { _tag: "HashMismatch", material, observedSha256: bytes.sha256 };
  }
  if (bytes.byteLength !== material.byteLength) {
    return { _tag: "ByteLengthMismatch", material, observedByteLength: bytes.byteLength };
  }
  return { _tag: "Verified", material };
}
