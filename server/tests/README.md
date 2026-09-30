# Money tests

These run the real schema, the real migrations and the real controllers
against a real PostgreSQL — an in-process one (PGlite), so no database
server is needed and nothing touches your data.

    cd server
    npm install
    npm test                                  # everything
    npm test -- owners_journal_test.mjs       # one file

`npm test` copies `config/` into `tests/cfg` first, so the tests always run
against the migrations you are about to ship. The same command runs on
GitHub for every push (`.github/workflows/tests.yml`).

The ones that matter most:

| File | What it proves |
|---|---|
| `owners_journal_test.mjs` | A month of trading through the real controllers. The automatic journal balances event by event; the trial balance, the balance sheet and cash flow agree to the cent — today and as at an earlier date. Owners' equity = capital + contributions − drawings + profit share. Excel/CSV import matches the exact customer or airline. |
| `audit_fixes_test.mjs` | The September 2026 audit: double cancels and double payments can't pay twice, deletes can't erase money, the edit form can't cancel, tax/as-of/transfer fees/overpayments on the balance sheet, one Cash in Hand per business. |
| `reconcile_test.mjs` | Accounts total = money in − money out, and every screen shows the same number. |
| `rules_test.mjs` | The cancellation rules: tax is not refundable, fees kept are revenue, the Tickets page and the income statement agree. |
| `group_test.mjs` | A group price split across passengers adds back up to the cent. |
| `equiv.mjs` | A fresh install (`schema.sql`) and an upgraded one (every migration re-run) end up identical. |

Accounts can't go below zero (the overdraft guard), so any test that pays
money out gives the paying account an opening balance first.

If you ever change how money is recorded, run these before deploying.
