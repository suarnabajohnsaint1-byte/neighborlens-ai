const NUMBERED = Array.from({ length: 41 }, (_, index) => `Barangay ${index + 1}`);

const NAMED = [
  'Alangilan', 'Alijis', 'Banago', 'Bata', 'Cabug',
  'Estefania', 'Felisa', 'Granada', 'Handumanan', 'Mandalagan',
  'Mansilingan', 'Montevista', 'Pahanocoy', 'Punta Taytay', 'Singcang-Airport',
  'Sum-ag', 'Taculing', 'Tangub', 'Villamonte', 'Vista Alegre'
];

const BACOLOD_CITY = 'Bacolod City';
const BACOLOD_PROVINCE = 'Negros Occidental';
const BACOLOD_REGION = 'Negros Island Region (NIR)';

const BACOLOD_BARANGAY_CATALOG = Object.freeze(
  [...NUMBERED, ...NAMED].map((name, index) => Object.freeze({ id: index + 1, name }))
);

const UPSERT_BARANGAY_SQL =
  'INSERT INTO barangays (id, name, city, province, region) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING';

function seedBarangayCatalogSync(db) {
  const statement = db.prepare(UPSERT_BARANGAY_SQL);
  for (const { id, name } of BACOLOD_BARANGAY_CATALOG) {
    statement.run(id, name, BACOLOD_CITY, BACOLOD_PROVINCE, BACOLOD_REGION);
  }
}

module.exports = {
  BACOLOD_BARANGAY_CATALOG,
  BACOLOD_CITY,
  BACOLOD_PROVINCE,
  BACOLOD_REGION,
  seedBarangayCatalogSync
};
