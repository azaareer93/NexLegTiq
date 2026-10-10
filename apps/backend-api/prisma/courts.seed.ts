import type { PrismaClient } from '../src/generated/prisma/client';
import type { CourtType, Jurisdiction } from '../src/generated/prisma/enums';

export interface CourtSeed {
  readonly jurisdiction: Jurisdiction;
  readonly courtType: CourtType;
  /** The seed key with the jurisdiction (unique among platform rows). */
  readonly nameEn: string;
  readonly nameAr: string;
  readonly city: string | null;
}

const ps = (
  courtType: CourtType,
  nameEn: string,
  nameAr: string,
  city: string | null,
): CourtSeed => ({
  jurisdiction: 'PALESTINE',
  courtType,
  nameEn,
  nameAr,
  city,
});

/** Magistrate (صلح), first-instance (بداية) and Sharia courts of each West Bank governorate seat. */
const PS_CITIES: readonly (readonly [string, string])[] = [
  ['Ramallah', 'رام الله'],
  ['Nablus', 'نابلس'],
  ['Hebron', 'الخليل'],
  ['Bethlehem', 'بيت لحم'],
  ['Jenin', 'جنين'],
  ['Tulkarm', 'طولكرم'],
  ['Qalqilya', 'قلقيلية'],
  ['Jericho', 'أريحا'],
  ['Salfit', 'سلفيت'],
  ['Tubas', 'طوباس'],
];

const jo = (courtType: CourtType, nameEn: string, nameAr: string, city: string): CourtSeed => ({
  jurisdiction: 'JORDAN',
  courtType,
  nameEn,
  nameAr,
  city,
});

const eg = (courtType: CourtType, nameEn: string, nameAr: string, city: string): CourtSeed => ({
  jurisdiction: 'EGYPT',
  courtType,
  nameEn,
  nameAr,
  city,
});

/**
 * Platform courts (D-037, D-115): Palestine (launch market) in full, the main courts of Jordan and Egypt. To be reviewed
 * by the owner before launch. Offices add the courts missing here as their own rows. Arabic city names are stored in
 * `city`, the English ones are in `nameEn`.
 */
export const COURTS: readonly CourtSeed[] = [
  ...PS_CITIES.flatMap(([en, ar]) => [
    ps('MAGISTRATE', `${en} Magistrate Court`, `محكمة صلح ${ar}`, ar),
    ps('FIRST_INSTANCE', `${en} First Instance Court`, `محكمة بداية ${ar}`, ar),
    ps('SHARIA', `${en} Sharia Court`, `محكمة ${ar} الشرعية`, ar),
  ]),
  ps('APPEAL', 'Ramallah Court of Appeal', 'محكمة استئناف رام الله', 'رام الله'),
  ps('APPEAL', 'Jerusalem Court of Appeal', 'محكمة استئناف القدس', 'رام الله'),
  ps('CASSATION', 'Court of Cassation', 'محكمة النقض', 'رام الله'),
  ps('ADMINISTRATIVE', 'Administrative Court', 'المحكمة الإدارية', 'رام الله'),
  ps('ADMINISTRATIVE', 'Supreme Administrative Court', 'المحكمة الإدارية العليا', 'رام الله'),
  ps('SUPREME', 'Supreme Constitutional Court', 'المحكمة الدستورية العليا', 'رام الله'),
  ps('CRIMINAL', 'Corruption Crimes Court', 'محكمة جرائم الفساد', 'رام الله'),
  ps('SHARIA', 'Sharia Court of Appeal', 'محكمة الاستئناف الشرعية', null),
  ps('SHARIA', 'Supreme Sharia Court', 'المحكمة العليا الشرعية', null),

  jo('CASSATION', 'Court of Cassation', 'محكمة التمييز', 'عمّان'),
  jo('APPEAL', 'Amman Court of Appeal', 'محكمة استئناف عمّان', 'عمّان'),
  jo('APPEAL', 'Irbid Court of Appeal', 'محكمة استئناف إربد', 'إربد'),
  jo('APPEAL', "Ma'an Court of Appeal", 'محكمة استئناف معان', 'معان'),
  jo('FIRST_INSTANCE', 'Amman First Instance Court', 'محكمة بداية عمّان', 'عمّان'),
  jo('FIRST_INSTANCE', 'Irbid First Instance Court', 'محكمة بداية إربد', 'إربد'),
  jo('FIRST_INSTANCE', 'Zarqa First Instance Court', 'محكمة بداية الزرقاء', 'الزرقاء'),
  jo('MAGISTRATE', 'Amman Civil Magistrate Court', 'محكمة صلح حقوق عمّان', 'عمّان'),
  jo('MAGISTRATE', 'Amman Criminal Magistrate Court', 'محكمة صلح جزاء عمّان', 'عمّان'),
  jo('CRIMINAL', 'Grand Criminal Court', 'محكمة الجنايات الكبرى', 'عمّان'),
  jo('ADMINISTRATIVE', 'Administrative Court', 'المحكمة الإدارية', 'عمّان'),
  jo('ADMINISTRATIVE', 'Supreme Administrative Court', 'المحكمة الإدارية العليا', 'عمّان'),
  jo('SUPREME', 'Constitutional Court', 'المحكمة الدستورية', 'عمّان'),
  jo('SHARIA', 'Amman Sharia Court of Appeal', 'محكمة الاستئناف الشرعية في عمّان', 'عمّان'),

  eg('CASSATION', 'Court of Cassation', 'محكمة النقض', 'القاهرة'),
  eg('SUPREME', 'Supreme Constitutional Court', 'المحكمة الدستورية العليا', 'القاهرة'),
  eg('APPEAL', 'Cairo Court of Appeal', 'محكمة استئناف القاهرة', 'القاهرة'),
  eg('APPEAL', 'Alexandria Court of Appeal', 'محكمة استئناف الإسكندرية', 'الإسكندرية'),
  eg('APPEAL', 'Tanta Court of Appeal', 'محكمة استئناف طنطا', 'طنطا'),
  eg('APPEAL', 'Mansoura Court of Appeal', 'محكمة استئناف المنصورة', 'المنصورة'),
  eg('APPEAL', 'Assiut Court of Appeal', 'محكمة استئناف أسيوط', 'أسيوط'),
  eg(
    'FIRST_INSTANCE',
    'North Cairo Court of First Instance',
    'محكمة شمال القاهرة الابتدائية',
    'القاهرة',
  ),
  eg(
    'FIRST_INSTANCE',
    'South Cairo Court of First Instance',
    'محكمة جنوب القاهرة الابتدائية',
    'القاهرة',
  ),
  eg('FIRST_INSTANCE', 'Giza Court of First Instance', 'محكمة الجيزة الابتدائية', 'الجيزة'),
  eg(
    'FIRST_INSTANCE',
    'Alexandria Court of First Instance',
    'محكمة الإسكندرية الابتدائية',
    'الإسكندرية',
  ),
  eg('COMMERCIAL', 'Cairo Economic Court', 'المحكمة الاقتصادية بالقاهرة', 'القاهرة'),
  eg('ADMINISTRATIVE', 'Supreme Administrative Court', 'المحكمة الإدارية العليا', 'القاهرة'),
  eg('ADMINISTRATIVE', 'Court of Administrative Judiciary', 'محكمة القضاء الإداري', 'القاهرة'),
];

/**
 * Idempotent: platform courts are keyed by jurisdiction + English name; an existing row gets the seed's Arabic name, type
 * and city (the platform owns these rows; offices cannot edit them), a missing one is created. Renaming `nameEn` here
 * creates a new row — retire the old one with a migration. Offices' own courts are never touched.
 */
export async function seedCourts(prisma: PrismaClient): Promise<void> {
  for (const { jurisdiction, nameEn, ...rest } of COURTS) {
    const { count } = await prisma.court.updateMany({
      where: { officeId: null, jurisdiction, nameEn },
      data: rest,
    });
    if (count === 0) await prisma.court.create({ data: { jurisdiction, nameEn, ...rest } });
  }
}
