import type { ClientUpload, PortalUpload } from '@nexlegtiq/shared-contracts';

import type { Prisma } from '../../generated/prisma/client';

/** What the portal and the office see of a client upload (D-187). */

/** The fields the client's view needs. */
export const portalUploadSelect = {
  id: true,
  fileId: true,
  originalFilename: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  rejectionReason: true,
  createdAt: true,
} satisfies Prisma.ClientUploadSelect;

/** The client's view of an upload row. */
export const toPortalUpload = (row: {
  id: string;
  fileId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: bigint;
  status: PortalUpload['status'];
  rejectionReason: string | null;
  createdAt: Date;
}): PortalUpload => ({
  id: row.id,
  fileId: row.fileId,
  name: row.originalFilename,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes.toString(),
  status: row.status,
  rejectionReason: row.rejectionReason,
  createdAt: row.createdAt.toISOString(),
});

export const uploadSelect = {
  ...portalUploadSelect,
  reviewedAt: true,
  documentId: true,
  client: { select: { id: true, displayName: true } },
  clientUser: { select: { fullName: true } },
  reviewedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.ClientUploadSelect;
type UploadRow = Prisma.ClientUploadGetPayload<{ select: typeof uploadSelect }>;

export const toClientUpload = (row: UploadRow): ClientUpload => ({
  ...toPortalUpload(row),
  client: row.client,
  uploaderName: row.clientUser.fullName,
  reviewedBy: row.reviewedBy,
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
  documentId: row.documentId,
});
