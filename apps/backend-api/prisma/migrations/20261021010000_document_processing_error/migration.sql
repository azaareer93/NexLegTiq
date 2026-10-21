-- Error code of a document whose processing failed (D-132): EXT-002 when text extraction failed; null for a failed scan.
ALTER TABLE "documents" ADD COLUMN "processing_error_code" TEXT;
