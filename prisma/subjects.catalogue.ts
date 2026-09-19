/* ---------------------------------------------------------------------------
   The institute's subject catalogue — data only, deliberately.

   This lived inside `seed-curriculum.ts`, which calls `main()` at module load.
   Importing the list from there just to read the spellings would CONNECT TO THE
   DATABASE AND SEED IT as a side effect of the import. Anything that only needs
   to know the subjects and their aliases imports this file instead.
--------------------------------------------------------------------------- */

// Subject codes MUST match the catalogue already in the database, so a re-run
// upserts the existing row rather than creating a duplicate (التفسير is TAFSEER,
// not TAFSIR). محور القرآن and علوم الآلات are real subjects used by PREP.
export const SUBJECTS = [
  {
    code: 'QURAN',
    nameAr: 'القرآن الكريم',
    shortAr: 'قرآن',
    aliases: ['قرآن', 'القرآن الكريم'],
  },
  {
    code: 'TAJWEED',
    nameAr: 'التجويد',
    shortAr: 'تجويد',
    aliases: ['تجويد', 'التجويد'],
  },
  {
    code: 'TAFSEER',
    nameAr: 'التفسير',
    shortAr: 'تفسير',
    aliases: ['تفسير', 'التفسير'],
  },
  {
    code: 'QURAN_SCI',
    nameAr: 'علوم القرآن',
    shortAr: 'علوم قرآن',
    aliases: ['علوم القرآن', 'علوم قرآن'],
  },
  {
    code: 'AQEEDAH',
    nameAr: 'العقيدة',
    shortAr: 'عقيدة',
    aliases: ['عقيدة', 'العقيدة'],
  },
  { code: 'FIQH', nameAr: 'الفقه', shortAr: 'فقه', aliases: ['فقه', 'الفقه'] },
  {
    code: 'USUL_FIQH',
    nameAr: 'أصول الفقه',
    shortAr: 'أصول فقه',
    aliases: ['أصول الفقه', 'أصول فقه'],
  },
  {
    code: 'HADITH_TERM',
    nameAr: 'مصطلح الحديث',
    shortAr: 'مصطلح',
    aliases: ['مصطلح', 'مصطلح الحديث'],
  },
  {
    code: 'TAKHREEJ',
    nameAr: 'أصول التخريج',
    shortAr: 'تخريج',
    aliases: ['تخريج', 'أصول التخريج'],
  },
  {
    code: 'ARABIC',
    nameAr: 'اللغة العربية',
    shortAr: 'لغة',
    aliases: ['لغة', 'اللغة العربية'],
  },
  { code: 'NAHW', nameAr: 'النحو', shortAr: 'نحو', aliases: ['نحو', 'النحو'] },
  {
    code: 'BALAGHA',
    nameAr: 'البلاغة',
    shortAr: 'بلاغة',
    aliases: ['بلاغة', 'البلاغة'],
  },
  {
    code: 'SEERAH',
    nameAr: 'السيرة',
    shortAr: 'سيرة',
    aliases: ['سيرة', 'السيرة'],
  },
  { code: 'FIKR', nameAr: 'الفكر', shortAr: 'فكر', aliases: ['فكر', 'الفكر'] },
  {
    code: 'TAZKIYAH',
    nameAr: 'التزكية',
    shortAr: 'تزكية',
    aliases: ['تزكية', 'التزكية'],
  },
  {
    code: 'QURAN_AXIS',
    nameAr: 'محور القرآن',
    shortAr: 'محور القرآن',
    aliases: ['محور القرآن'],
  },
  {
    code: 'ALAT_SCI',
    nameAr: 'علوم الآلات',
    shortAr: 'علوم الآلات',
    aliases: ['علوم الآلات'],
  },
  { code: 'HIFZ', nameAr: 'الحفظ', shortAr: 'حفظ', aliases: ['حفظ', 'الحفظ'] },
] as const;
