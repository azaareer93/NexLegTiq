import {
  AddReportedCourtSchema,
  AdminCourtQuerySchema,
  AdminCourtReportQuerySchema,
  AdminCourtReportSchema,
  AdminOfficeCourtQuerySchema,
  CourtQuerySchema,
  CourtReportSchema,
  CourtSchema,
  CreateCourtSchema,
  CreateJudgeSchema,
  CreateProsecutorSchema,
  DismissCourtReportSchema,
  JudgeSchema,
  OfficeCourtSchema,
  PromoteOfficeCourtSchema,
  ProsecutorQuerySchema,
  ProsecutorSchema,
  ReplaceOfficeCourtResultSchema,
  ReplaceOfficeCourtSchema,
  ReportCourtSchema,
  UpdateCourtSchema,
  UpdateJudgeSchema,
  UpdateProsecutorSchema,
} from './court.contract.js';

const ID = '01920000-0000-7000-8000-000000000001';
const AT = '2026-11-28T10:00:00.000Z';

const messages = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) =>
  result.success
    ? []
    : (result.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);

const court = {
  id: ID,
  jurisdiction: 'PALESTINE',
  courtType: 'MAGISTRATE',
  nameAr: 'محكمة صلح يطا',
  nameEn: 'Yatta Magistrate Court',
  city: null,
  address: null,
  phone: null,
  email: null,
  isPlatform: true,
  isActive: true,
  createdAt: AT,
  updatedAt: AT,
};

describe('court contracts (D-115, D-266)', () => {
  describe('CreateCourtSchema (admin)', () => {
    const body = {
      jurisdiction: 'PALESTINE',
      courtType: 'MAGISTRATE',
      nameAr: '  محكمة صلح يطا ',
      nameEn: ' Yatta Magistrate Court ',
    };

    it('should trim the names and keep the optional fields optional', () => {
      expect(CreateCourtSchema.parse(body)).toEqual({
        jurisdiction: 'PALESTINE',
        courtType: 'MAGISTRATE',
        nameAr: 'محكمة صلح يطا',
        nameEn: 'Yatta Magistrate Court',
      });
      expect(
        CreateCourtSchema.parse({
          ...body,
          city: ' يطا ',
          address: 'شارع ١',
          phone: '+970 2 123 4567',
          email: ' Court@Example.TEST ',
        }),
      ).toMatchObject({ city: 'يطا', email: 'court@example.test' });
    });

    it('should require a country of the fixed list, a type and both names', () => {
      expect(messages(CreateCourtSchema.safeParse({ ...body, jurisdiction: 'ATLANTIS' }))).toEqual([
        expect.stringMatching(/^jurisdiction: /),
      ]);
      expect(messages(CreateCourtSchema.safeParse({ ...body, courtType: 'NOPE' }))).toEqual([
        expect.stringMatching(/^courtType: /),
      ]);
      expect(messages(CreateCourtSchema.safeParse({ ...body, nameAr: '   ', nameEn: '' }))).toEqual(
        ['nameAr: validation.required', 'nameEn: validation.required'],
      );
      const { nameEn: _omit, ...noEnglish } = body;
      expect(CreateCourtSchema.safeParse(noEnglish).success).toBe(false);
    });

    it('should refuse a bad phone and a bad email', () => {
      expect(messages(CreateCourtSchema.safeParse({ ...body, phone: 'abc' }))).toEqual([
        'phone: validation.phone',
      ]);
      expect(CreateCourtSchema.safeParse({ ...body, email: 'not-an-email' }).success).toBe(false);
    });
  });

  describe('UpdateCourtSchema (admin)', () => {
    it('should take any subset, null to clear an optional field, and isActive', () => {
      expect(UpdateCourtSchema.parse({ isActive: false, city: null })).toEqual({
        isActive: false,
        city: null,
      });
      expect(UpdateCourtSchema.parse({ nameAr: ' محكمة ' })).toEqual({ nameAr: 'محكمة' });
    });

    it('should refuse an empty body, a null name and a country change', () => {
      expect(messages(UpdateCourtSchema.safeParse({}))).toEqual([': validation.required']);
      expect(UpdateCourtSchema.safeParse({ nameEn: null }).success).toBe(false);
      // The country is fixed once created: an unknown key is dropped, leaving an empty body.
      expect(UpdateCourtSchema.safeParse({ jurisdiction: 'JORDAN' }).success).toBe(false);
    });
  });

  describe('queries', () => {
    it("should page the office picker and drop a jurisdiction (it is the office's)", () => {
      expect(CourtQuerySchema.parse({})).toEqual({ page: 1, limit: 50 });
      expect(
        CourtQuerySchema.parse({ jurisdiction: 'JORDAN', search: ' رام ', page: '2' }),
      ).toEqual({ search: 'رام', page: 2, limit: 50 });
      expect(CourtQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    });

    it('should require the country for the admin list', () => {
      expect(AdminCourtQuerySchema.safeParse({}).success).toBe(false);
      expect(AdminCourtQuerySchema.parse({ jurisdiction: 'EGYPT', courtType: 'APPEAL' })).toEqual({
        jurisdiction: 'EGYPT',
        courtType: 'APPEAL',
        page: 1,
        limit: 50,
      });
    });

    it('should filter reports by a known status only, and office courts by text', () => {
      expect(AdminCourtReportQuerySchema.parse({ status: 'PENDING' })).toMatchObject({
        status: 'PENDING',
      });
      expect(AdminCourtReportQuerySchema.safeParse({ status: 'OPEN' }).success).toBe(false);
      expect(AdminOfficeCourtQuerySchema.parse({ search: ' مكتب ' })).toMatchObject({
        search: 'مكتب',
      });
    });
  });

  describe('legacy office courts', () => {
    it('should replace with a court id only', () => {
      expect(ReplaceOfficeCourtSchema.parse({ courtId: ID })).toEqual({ courtId: ID });
      expect(ReplaceOfficeCourtSchema.safeParse({ courtId: 'x' }).success).toBe(false);
      expect(
        ReplaceOfficeCourtResultSchema.parse({ courtId: ID, files: 2, sessions: 1, judges: 0 }),
      ).toMatchObject({ files: 2 });
    });

    it('should promote with an optional, non-blank English name', () => {
      expect(PromoteOfficeCourtSchema.parse({})).toEqual({});
      expect(PromoteOfficeCourtSchema.parse({ nameEn: ' Jenin Court ' })).toEqual({
        nameEn: 'Jenin Court',
      });
      expect(messages(PromoteOfficeCourtSchema.safeParse({ nameEn: ' ' }))).toEqual([
        'nameEn: validation.required',
      ]);
    });

    it('should describe an office court with its office and usage', () => {
      const row = {
        ...court,
        isPlatform: false,
        officeId: ID,
        officeName: 'مكتب',
        fileCount: 1,
        sessionCount: 0,
        judgeCount: 2,
      };
      expect(OfficeCourtSchema.parse(row)).toEqual(row);
      expect(OfficeCourtSchema.safeParse({ ...row, fileCount: 1.5 }).success).toBe(false);
    });
  });

  describe('missing-court reports', () => {
    it('should trim a report and require its name', () => {
      expect(ReportCourtSchema.parse({ name: ' محكمة صلح يطا ', city: ' يطا ' })).toEqual({
        name: 'محكمة صلح يطا',
        city: 'يطا',
      });
      expect(messages(ReportCourtSchema.safeParse({ name: '' }))).toEqual([
        'name: validation.required',
      ]);
      expect(messages(ReportCourtSchema.safeParse({ name: 'x', note: 'n'.repeat(1001) }))).toEqual([
        'note: validation.tooLong',
      ]);
    });

    it('should add a reported court without a country (it is the office one)', () => {
      const body = { courtType: 'MAGISTRATE', nameAr: 'م', nameEn: 'M', jurisdiction: 'JORDAN' };
      expect(AddReportedCourtSchema.parse(body)).toEqual({
        courtType: 'MAGISTRATE',
        nameAr: 'م',
        nameEn: 'M',
      });
      expect(
        AddReportedCourtSchema.safeParse({ courtType: 'MAGISTRATE', nameAr: 'م' }).success,
      ).toBe(false);
    });

    it('should dismiss with an optional reason of bounded length', () => {
      expect(DismissCourtReportSchema.parse({})).toEqual({});
      expect(DismissCourtReportSchema.parse({ reason: ' موجودة ' })).toEqual({ reason: 'موجودة' });
      expect(DismissCourtReportSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    });

    it('should read reports for the office and the admin', () => {
      const report = {
        id: ID,
        name: 'م',
        city: null,
        note: null,
        status: 'PENDING',
        createdAt: AT,
      };
      expect(CourtReportSchema.parse(report)).toEqual(report);
      expect(CourtReportSchema.safeParse({ ...report, status: 'OPEN' }).success).toBe(false);
      const admin = {
        ...report,
        officeId: ID,
        officeName: 'مكتب',
        jurisdiction: 'PALESTINE',
        reportedByName: 'ليلى',
        courtId: null,
        dismissReason: null,
        resolvedAt: null,
      };
      expect(AdminCourtReportSchema.parse(admin)).toEqual(admin);
      expect(AdminCourtReportSchema.safeParse({ ...admin, jurisdiction: 'NOWHERE' }).success).toBe(
        false,
      );
    });
  });

  describe('responses, judges and prosecutors', () => {
    it('should read a court and require its active flag', () => {
      expect(CourtSchema.parse(court)).toEqual(court);
      const { isActive: _omit, ...withoutFlag } = court;
      expect(CourtSchema.safeParse(withoutFlag).success).toBe(false);
    });

    it('should validate judges', () => {
      expect(CreateJudgeSchema.parse({ fullName: ' القاضي ' })).toEqual({ fullName: 'القاضي' });
      expect(UpdateJudgeSchema.safeParse({}).success).toBe(false);
      expect(UpdateJudgeSchema.parse({ isActive: false, notes: null })).toEqual({
        isActive: false,
        notes: null,
      });
      const judge = {
        id: ID,
        courtId: ID,
        fullName: 'القاضي',
        isActive: true,
        notes: null,
        isPlatform: false,
        createdAt: AT,
        updatedAt: AT,
      };
      expect(JudgeSchema.parse(judge)).toEqual(judge);
    });

    it('should validate prosecutors', () => {
      expect(CreateProsecutorSchema.parse({ fullName: ' وكيل ', officeName: 'نيابة' })).toEqual({
        fullName: 'وكيل',
        officeName: 'نيابة',
      });
      expect(UpdateProsecutorSchema.safeParse({}).success).toBe(false);
      expect(UpdateProsecutorSchema.parse({ phone: null })).toEqual({ phone: null });
      expect(ProsecutorQuerySchema.parse({})).toEqual({ page: 1, limit: 50 });
      const prosecutor = {
        id: ID,
        fullName: 'وكيل',
        officeName: null,
        phone: null,
        email: null,
        createdAt: AT,
        updatedAt: AT,
      };
      expect(ProsecutorSchema.parse(prosecutor)).toEqual(prosecutor);
    });
  });
});
