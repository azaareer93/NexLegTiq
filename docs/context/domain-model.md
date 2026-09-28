# Domain Model (canonical)

> Source: Notion "ENTITY MODELS" (34 entities) + fixes from `decisions.md` (D-015…D-039).
> Conventions: UUID v7 ids; `createdAt`, `updatedAt` on every table; `deletedAt` soft delete on user-facing
> records (files, clients, documents, tasks); enums UPPER_SNAKE; money `Decimal(14,2)` + `currency`;
> **every tenant-owned table has `officeId` (non-null)** — marked 🔒. `officeId?` = nullable for global reference rows.

## Tenancy & identity
- **Office** — name, registrationNumber, taxId, phone, email, address, website, `jurisdiction: Jurisdiction`
  (default PALESTINE), `defaultLanguage: AR|EN|BILINGUAL`, `currency` (ISO), `timezone` (default Asia/Hebron),
  `isActive`. Settings live in **OfficeSettings** 🔒 (typed columns, not key/value): courtReminderDays int[] (7,3,1),
  taskReminderDays, defaultBillingRate, defaultBillingMethod, taxRatePercent, enableAI, enableOCR,
  fileNumberFormat, sessionIdleMinutes, auditRetentionDays (≥365).
- **Plan** (platform) / **Subscription** 🔒 — D-005.
- **User** 🔒 — fullName, email (citext, unique global D-032), passwordHash, `role: Role`, phone, avatarUrl, isActive,
  lastLoginAt, uiLanguage, timezone, mfaSecret? (encrypted), mfaEnabled.
  `Role` = OFFICE_MANAGER, SENIOR_LAWYER, LAWYER, PARALEGAL, ADMIN (office admin/finance), TRAINEE, EXTERNAL_COLLABORATOR.
- **PlatformAdmin** — separate table for the admin panel (not an office role); MFA required.
- **OfficeInvitation** 🔒 — email, role (any except OFFICE_MANAGER; SENIOR_LAWYER allowed), tokenHash, status
  PENDING|ACCEPTED|EXPIRED|REVOKED, expiresAt (7d), invitedById, message.
- **RefreshToken**, **PasswordResetToken** (hashed, 1h, usedAt), **LoginAttempt** (email, ip, success, at).
- **LegalAcceptance** — userId|clientUserId, documentType TOS|PRIVACY|DPA, version, acceptedAt, ip.

## Clients & parties
- **Client** 🔒 — `clientType: INDIVIDUAL|CORPORATION|GOVERNMENT|NGO|PARTNERSHIP`, displayName, fullName?,
  companyName?, nationalId? (encrypted), taxId?, phone, email, address, industry, primaryLawyerId?, isActive.
- **ContactPerson** 🔒 — clientId, fullName, position, email, phone, isPrimary.
- **ClientUser** 🔒 (portal) — clientId, email, fullName, passwordHash?, isActive, lastLoginAt; **ClientInvitation** 🔒.
- **Party** 🔒 — isIndividual, fullName / companyName, nationalId? (encrypted), taxId?, address, phone,
  legalRepresentative, notes (encrypted). Reused across files for conflict checks.
- **FileParty** 🔒 — fileId, partyId, `partyType: PLAINTIFF|DEFENDANT|APPELLANT|RESPONDENT|THIRD_PARTY|GUARANTOR|
  SIGNATORY|INTERESTED_PARTY|PROSECUTION`, roleLabel (free text e.g. "Landlord"), joinedAt.
- **ConflictOfInterest** 🔒 — fileIdA, fileIdB, partyId, reason, detectedAt, resolved, resolutionNotes, resolvedById.

## Legal files (cases)
- **LegalFile** 🔒 — fileNumber (`@@unique([officeId, fileNumber])`), title, description,
  `fileType: LITIGATION|CRIMINAL|CONTRACT_DRAFTING|LEGAL_ADVISORY|COMPLIANCE|CONFLICT_RESOLUTION|BUSINESS_SUPPORT|
  NDA_REVIEW|WILL_TRUST|COMPANY_FORMATION|RENTAL_AGREEMENT|EMPLOYMENT_CONTRACT`, subType?,
  `status: OPEN|SUSPENDED|CLOSED|ARCHIVED`, `priority: LOW|MEDIUM|HIGH|URGENT`, openingDate, closingDate?,
  responsibleLawyerId, responsibleParalegalId?, courtId?, judgeId?, courtCaseNumber?, jurisdiction,
  `billingMethod: HOURLY|FIXED_FEE|RETAINER|CONTINGENCY`, hourlyRate?, fixedFee?, retainerBalance Decimal,
  currency, isConfidential, embedding vector(1536)? (Phase 2).
- **FileClient** 🔒 (fileId, clientId, isPrimary) · **FileTeamMember** 🔒 (fileId, userId, role).
- **FileNumberSequence** 🔒 (officeId, year, typeCode, next).
- **FileNote** 🔒 — fileId?, clientId?, authorId, body, isConfidential (encrypted when confidential), pinned.
- **CaseTimelineEvent** 🔒 — fileId, `eventType` (FILE_OPENED, FILE_CLOSED, FILE_REOPENED, FILE_REASSIGNED,
  SESSION_CREATED, SESSION_UPDATED, DOCUMENT_UPLOADED, DOCUMENT_SHARED, TASK_COMPLETED, PARTY_ADDED,
  WITNESS_STATEMENT_ADDED, SUMMARY_GENERATED, INVOICE_SENT, INVOICE_PAID, …), sourceType, sourceId (uuid),
  occurredAt, actorId, payload JSON (i18n params — display text is rendered client-side, not stored).
- **TaskTemplate** 🔒 — name, fileType?, defaultTitle, defaultDescription, dueDaysAfterOpen, defaultAssigneeRole.

## Courts & hearings
- **Court** (officeId? — global or office) — name (ar/en), `courtType: CourtType` (D-037), jurisdiction, city,
  address, phone, email. `@@unique([officeId, jurisdiction, name])`.
- **Judge** (officeId?) — courtId, fullName, isActive, notes.
- **PublicProsecutor** 🔒 — fullName, officeName, phone, email.
- **Session** 🔒 — fileId, courtId?, judgeId?, `sessionType: HEARING|MEDIATION|ARBITRATION|PRE_TRIAL|
  STATUS_CONFERENCE|APPEAL_HEARING|JUDGMENT_PRONOUNCEMENT`, startsAt (timestamptz), endsAt?, courtRoom,
  `outcome?: ADJOURNED|DECIDED|SETTLED|DISMISSED|POSTPONED`, nextSessionId?, minutes (text), isCancelled,
  reminderDays int[], attendingLawyerId. Derived status SCHEDULED/COMPLETED/CANCELLED.
- **SessionReminder** 🔒 — D-036. **SessionPartyAttendance** 🔒.
- **Witness** 🔒 / **WitnessStatement** 🔒 — as Notion, statement.aiSummaryId?.

## Documents & OCR
- **DocumentFolder** 🔒 — fileId, parentId?, name, systemKey? (PLEADINGS, EVIDENCE, COURT_ORDERS, CONTRACTS,
  CORRESPONDENCE, CLIENT_UPLOADS…).
- **Document** 🔒 — fileId, folderId?, sessionId?, name, originalFilename, `documentType` (PLEADING, EVIDENCE,
  CONTRACT_DRAFT, FINAL_CONTRACT, WILL, NDA, COURT_ORDER, JUDGMENT, CLIENT_INSTRUCTION, INVOICE, LEGAL_NOTICE,
  DEMAND_LETTER, POWER_OF_ATTORNEY, CORRESPONDENCE, OTHER), mimeType, sizeBytes, checksumSha256, storageKey,
  currentVersion, `status: UPLOADED|SCANNING|PROCESSING|READY|FAILED|QUARANTINED`, `ocrStatus: NOT_NEEDED|PENDING|
  DONE|FAILED`, language (AR|EN|MIXED), isConfidential, sharedWithClient, uploadedById | uploadedByClientUserId.
- **DocumentVersion** 🔒 — versionNumber, storageKey, sizeBytes, checksum, createdById, changeNote.
- **DocumentText** 🔒 — documentId, versionNumber, text, `searchVectorSimple tsvector`, `searchVectorEnglish tsvector`,
  pageCount, ocrEngine, ocrConfidence, extractedAt. (Replaces DocumentSearchIndex; keeps big text out of Document.)

## Tasks
- **Task** 🔒 — fileId?, title, description, dueDate, `priority`, `status: TODO|IN_PROGRESS|BLOCKED|DONE`,
  assignedToId, createdById, completedAt, sortOrder (Kanban), sourceType? (TEMPLATE|AI_NEXT_STEP|MANUAL), sourceId?,
  isRecurring, recurrenceRule (RRULE string, Phase 2), reminderSentAt.

## Billing
- **TimeEntry** 🔒 — userId, fileId, date, durationHours Decimal(6,2), description, isBillable, hourlyRate, currency,
  invoiceId? (locks entry once invoiced).
- **Invoice** 🔒 — clientId, fileId? (null = consolidated), invoiceNumber (`@@unique([officeId, invoiceNumber])`,
  `INV-{YEAR}-{SEQ:4}`), issueDate, dueDate, currency, subtotal, taxRatePercent, taxAmount, total,
  `status: DRAFT|SENT|PAID|OVERDUE|VOID`, sentAt, paidAt, notes, pdfStorageKey, sharedWithClient.
- **InvoiceLineItem** 🔒 — description, quantity, unitPrice, amount, timeEntryId?.

## AI
- **AiSummary** 🔒 — `sourceType` (D-039), sourceId, fileId, language, summary, keyFacts JSON, keyLegalIssues JSON,
  nextSteps JSON?, riskAssessment?, model, provider, promptVersion, createdById, createdAt.
- **AiJob** 🔒 — type, sourceType, sourceId, status QUEUED|RUNNING|SUCCEEDED|FAILED, error, attempts, jobId.
- **AiUsage** 🔒 — feature, provider, model, inputTokens, outputTokens, costUsd Decimal(10,6), durationMs, cached, userId.
- Phase 2: ContractAnalysis, EvidenceSuggestion, DocumentTemplate, GeneratedDocument, LocalCourtProcess,
  FileProcessTracker, VoiceNote, IngestedEmail.

## Cross-cutting
- **AuditLog** 🔒 — userId?|clientUserId?|platformAdminId?, entityType, entityId, `action: CREATE|UPDATE|DELETE|VIEW|
  DOWNLOAD|SHARE|LOGIN|LOGOUT|EXPORT|PERMISSION_DENIED`, oldValues JSON?, newValues JSON? (secrets redacted),
  ipAddress, userAgent, requestId, occurredAt. Append-only (no update/delete grants for app role).
- **Notification** 🔒 — userId|clientUserId, type, titleKey, params JSON, link, readAt, channel.
- **ConsentRecord** — cookie/marketing consents.

## Invariants (test these)
1. No query on a 🔒 model without `officeId` (tenant extension throws in dev/test).
2. `fileNumber` and `invoiceNumber` unique per office and gap-free per year+type (transactional sequence).
3. Closing a file with open tasks → `BIZ-003` unless `force` with reason; closing cancels pending reminders.
4. Archived files are read-only (writes → `BIZ-007 FILE_ARCHIVED`).
5. Session conflict: same attending lawyer overlapping `[startsAt, endsAt ?? startsAt+1h)` → `409 BIZ-004`
   (can override with `acknowledgeConflict=true`).
6. Adding a party already on another office file on the opposing side → ConflictOfInterest record + warning.
7. Invoiced time entries are immutable; `PAID` invoices can't be edited (`BIZ-006`).
8. ClientUser can only reach files linked via FileClient and only `sharedWithClient` documents/invoices.
