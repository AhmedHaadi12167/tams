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

If you ever change how money is recorded, run these before deploying.
