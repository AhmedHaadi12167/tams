/**
 * seedAccounts — the payment accounts a test business trades with.
 *
 * Until migration_v21 the database created these itself, so every test could
 * assume a business had eleven accounts the moment it existed. v21 stopped
 * that: an agency now names its own accounts, and a new business genuinely
 * has none.
 *
 * That is the right product behaviour and the wrong test fixture, so the
 * eleven names live here instead. Tests call this straight after creating a
 * business and carry on unchanged.
 *
 * Deliberately raw SQL rather than the controller: a fixture should set up
 * the world, not exercise the code under test on the way in.
 */
export const ACCOUNT_SET = [
  ["Cash", "cash", 0],
  ["Premier Bank", "bank", 10],
  ["Salaam Bank", "bank", 20],
  ["Amal Bank", "bank", 30],
  ["MyBank", "bank", 40],
  ["Dahabshiil Bank", "bank", 50],
  ["IBS Bank", "bank", 60],
  ["SOMBANK", "bank", 70],
  ["Merchant", "merchant", 80],
  ["EVC", "mobile", 90],
  ["EDahab", "mobile", 100],
];

export const seedAccounts = async (pg, businessId) => {
  for (const [name, kind, sort] of ACCOUNT_SET) {
    await pg.query(
      `INSERT INTO payment_accounts (business_id, name, kind, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, name) DO NOTHING`,
      [businessId, name, kind, sort],
    );
  }
};
