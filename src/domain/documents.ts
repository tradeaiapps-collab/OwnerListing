import type { JobAssignment } from "./job-chat";

export type DocumentKind =
  | "photo" | "photo_360" | "video" | "video_360" | "floorplan" | "title_search" | "building_inspection" | "pest_report" | "contract" | "other";
export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "photo", "photo_360", "video", "video_360", "floorplan", "title_search", "building_inspection", "pest_report", "contract", "other"
];
export type Visibility = "public" | "parties" | "owner_only";
export type DocumentStatus = "active" | "held" | "superseded";

export interface DocumentRecord {
  id: string;
  listingId: string;
  ownerUserId: string;
  kind: DocumentKind;
  uploadedBy: string;
  visibility: Visibility;
  status: DocumentStatus;
  /** Optional display title shown to buyers. */
  title?: string;
  /** Set on an amended file: the earlier version it replaced. Earlier versions are kept. */
  supersedesId?: string;
}

export interface UploadRequest {
  kind: DocumentKind;
  declaredMime: string;
  sizeBytes: number;
  sha256: string;
}

const IMAGE = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const PDF = ["application/pdf"];
const VIDEO = ["video/mp4", "video/quicktime"];
const ALLOWED_MIME: Record<DocumentKind, readonly string[]> = {
  photo: IMAGE, photo_360: IMAGE, video: VIDEO, video_360: VIDEO, floorplan: [...IMAGE, ...PDF], title_search: PDF,
  building_inspection: PDF, pest_report: PDF, contract: PDF, other: [...IMAGE, ...PDF]
};
const MAX_BYTES: Record<DocumentKind, number> = {
  photo: 25_000_000, photo_360: 100_000_000, video: 2_000_000_000, video_360: 4_000_000_000, floorplan: 50_000_000, title_search: 50_000_000,
  building_inspection: 50_000_000, pest_report: 50_000_000, contract: 50_000_000, other: 50_000_000
};

/** Declared-type check only. The upload service must also check the file's real content and scan it. */
export function validateUpload(u: UploadRequest): string[] {
  const problems: string[] = [];
  if (!ALLOWED_MIME[u.kind].includes(u.declaredMime)) problems.push(`File type ${u.declaredMime} is not allowed for ${u.kind}.`);
  if (!Number.isInteger(u.sizeBytes) || u.sizeBytes <= 0) problems.push("File is empty.");
  else if (u.sizeBytes > MAX_BYTES[u.kind]) problems.push("File is too large.");
  if (!/^[0-9a-f]{64}$/i.test(u.sha256)) problems.push("A SHA-256 fingerprint is required.");
  return problems;
}

/** What each approved contractor type may add. */
const CONTRACTOR_KINDS: Record<JobAssignment["kind"], readonly DocumentKind[]> = {
  photographer: ["photo", "photo_360", "video", "video_360", "floorplan"],
  inspector: ["building_inspection", "pest_report"],
  solicitor: ["contract", "title_search"],
  agent: ["photo", "photo_360", "video", "video_360", "floorplan"],
  pest_control: ["pest_report", "photo"],
  other: ["photo", "other"]
};

export function canUploadDocument(
  userId: string, ownerUserId: string, listingId: string, kind: DocumentKind,
  assignments: readonly JobAssignment[]
): boolean {
  if (userId === ownerUserId) return true;
  return assignments.some(a =>
    a.listingId === listingId && a.contractorUserId === userId && a.status === "approved" &&
    CONTRACTOR_KINDS[a.kind].includes(kind));
}

/** The kinds this user may add to the listing: every kind for the owner, otherwise what their approved assignments allow. */
export function uploadableKinds(
  userId: string, ownerUserId: string, listingId: string, assignments: readonly JobAssignment[]
): DocumentKind[] {
  return DOCUMENT_KINDS.filter(k => canUploadDocument(userId, ownerUserId, listingId, k, assignments));
}

/** Role check before the kind is known (used before the upload body is read). The kind is checked again once it is. */
export function canUploadAnyDocument(userId: string, ownerUserId: string, listingId: string, assignments: readonly JobAssignment[]): boolean {
  if (userId === ownerUserId) return true;
  return assignments.some(a =>
    a.listingId === listingId && a.contractorUserId === userId && a.status === "approved" && CONTRACTOR_KINDS[a.kind].length > 0);
}

export function canViewDocument(
  userId: string | undefined, doc: DocumentRecord, listingPublished: boolean,
  assignments: readonly JobAssignment[]
): boolean {
  if (userId !== undefined && userId === doc.ownerUserId) return true;
  if (doc.visibility === "public") return listingPublished;
  if (doc.visibility === "parties" && userId !== undefined) {
    return assignments.some(a =>
      a.listingId === doc.listingId && a.contractorUserId === userId &&
      (a.status === "approved" || a.status === "completed"));
  }
  return false;
}

export type DeletionOutcome =
  | { kind: "rejected"; reason: string }
  | { kind: "held"; reason: string }
  | { kind: "delete_now"; reason: string }
  | { kind: "amend_only"; reason: string };

/**
 * Before the listing has ever been published the owner may delete files freely.
 * After the owner's final approval to go live, files can be amended (replaced) but not deleted,
 * and every version's record is kept. Contracts and title searches of a completed sale are always held.
 */
export function evaluateDeletionRequest(
  userId: string,
  doc: DocumentRecord,
  ctx: { everPublished: boolean; saleCompleted: boolean }
): DeletionOutcome {
  if (userId !== doc.ownerUserId) return { kind: "rejected", reason: "Only the owner can delete files." };
  if (ctx.saleCompleted && (doc.kind === "contract" || doc.kind === "title_search")) {
    return { kind: "held", reason: "Kept for legal record-keeping after a completed sale." };
  }
  if (!ctx.everPublished) return { kind: "delete_now", reason: "The listing has not been published yet." };
  return { kind: "amend_only", reason: "Published files can be replaced but not deleted. The record is kept." };
}

/** Amending a published file creates a new version. The earlier version stays on record as superseded. */
export function amendDocument(previous: DocumentRecord, newId: string, uploadedBy: string): { previous: DocumentRecord; next: DocumentRecord } {
  if (previous.status !== "active") throw new Error("Only an active file can be amended.");
  return {
    previous: { ...previous, status: "superseded" },
    next: { ...previous, id: newId, uploadedBy, status: "active", supersedesId: previous.id }
  };
}
