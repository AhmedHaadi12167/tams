# Money tests

These run the real schema, the real migrations and the real controllers
against a real PostgreSQL — an in-process one (PGlite), so no database
server is needed and nothing touches your data.

    cd server/tests
    npm install @electric-sql/pglite
    cp -r ../config ./cfg
    node ledger_test.mjs      # views, balances, transfer arithmetic
    node equiv.mjs            # fresh install == upgraded install
    node reconcile_test.mjs   # controllers -> ledger -> accounts all agree
    node rules_test.mjs       # the four cancellation rules, end to end

`reconcile_test.mjs` is the important one. It books a ticket, takes a cargo
payment, records a visa, pays an airline, files an expense, moves money
between accounts and edits a shipment downward — then checks that the sum of
the account balances equals everything in minus everything out, and that the
Accounts screen shows the same number the database does.

`rules_test.mjs` guards the agency's four rules about cancelled tickets: the
tax is not refundable, a refund and a write-off can both apply to one ticket,
a full refund leaves no revenue, and a fee kept shows up as revenue. Its last
check is the one that matters most — the sum of the cancelled tickets' revenue
has to equal the income statement's net from cancellations, so the Tickets page
and the Financials page can never drift apart.

`group_test.mjs` covers the other way money can go wrong: division. A group
ticket is quoted as one combined price and stored as a row per passenger, so
$1,000 across three travellers has to come back as $1,000.00 and not $999.99.
It books the real thing through the real controller and checks the total from
both ends, that each ticket's own base + tax + surcharge still equals its
selling price, that the cash ledger counts one payment rather than one per
seat, and that a duplicate passenger rolls the whole booking back instead of
leaving half a group behind.

`extract_test.mjs` stubs the model and tests what happens to its answer:
titles stripped so "MR ABDIFATAH" and the contact do not become two
customers, the passenger list forced into an array whatever shape came back,
junk rows dropped, and a document that claims three passengers while listing
two reported rather than quietly accepted.

If you ever change how money is recorded, run these before deploying.
