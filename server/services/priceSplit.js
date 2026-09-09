/**
 * priceSplit.js — dividing one price across several passengers.
 *
 * A group ticket is quoted as one combined price: $1,000 for three people to
 * Nairobi. The system stores a row per passenger, because each one can be
 * cancelled, refunded or paid for on their own — so that $1,000 has to become
 * three numbers.
 *
 * THE TRAP
 *
 * $1,000 / 3 = $333.3333… Rounding each share to $333.33 stores $999.99, and
 * the agency is a cent short. Rounding up stores $1,000.01 and it is a cent
 * over. Either way the Tickets page and the invoice the customer was handed
 * disagree, and a cent that appears from nowhere is exactly as hard to
 * explain to an accountant as a thousand dollars.
 *
 * Worse, the error compounds: it happens on base_price, on tax, on
 * surcharge, on cost_price and on selling_price, so a three-passenger
 * booking can drift five cents in five directions and the revenue column
 * stops being the difference between the other two.
 *
 * THE RULE
 *
 * Work in whole cents, give the remainder away one cent at a time, and
 * guarantee the parts add up to the whole. $1,000 across three becomes
 * $333.34, $333.33, $333.33 — which sums to exactly $1,000.00.
 *
 * The extra cent goes to the earliest passenger rather than the last, so it
 * lands on the person the booking is filed under. That is arbitrary but it
 * is fixed, which means two runs of the same booking split it identically.
 */

/** Money in, money out — never floating-point drift in between. */
const toCents = (v) => Math.round((Number(v) || 0) * 100);
const toMoney = (cents) => Math.round(cents) / 100;

/**
 * Split an amount into `n` parts that sum to exactly the original.
 *
 * Negative totals are handled the same way (a credit divides like a charge),
 * which matters because a refund on a group booking runs through here too.
 *
 * @param {number|string} total  the combined figure, e.g. 1000 or "1000.00"
 * @param {number} n             how many passengers
 * @returns {number[]}           n amounts, summing to `total` to the cent
 */
const splitAmount = (total, n) => {
  const count = Math.max(Math.floor(Number(n) || 0), 0);
  if (count === 0) return [];

  const cents = toCents(total);
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);

  const base = Math.floor(abs / count);
  const remainder = abs - base * count; // 0 … count-1 spare cents

  return Array.from({ length: count }, (_, i) =>
    toMoney(sign * (base + (i < remainder ? 1 : 0))),
  );
};

/**
 * Split several amounts at once.
 *
 * Each column is divided independently, so each one sums back to its own
 * total. That is all this does — see splitBooking below for why that is not
 * enough on its own.
 *
 * @param {Object<string, number|string>} amounts  e.g. { cost_price: 900, ... }
 * @param {number} n
 * @returns {Array<Object<string, number>>}  one object per passenger
 */
const splitAmounts = (amounts, n) => {
  const keys = Object.keys(amounts);
  const columns = {};
  for (const k of keys) columns[k] = splitAmount(amounts[k], n);

  return Array.from({ length: Math.max(Math.floor(Number(n) || 0), 0) }, (_, i) => {
    const row = {};
    for (const k of keys) row[k] = columns[k][i];
    return row;
  });
};

/**
 * Split a whole booking, keeping each ticket internally consistent.
 *
 * THE SECOND TRAP
 *
 * Splitting every column on its own is not enough, and the failure is
 * subtle. Take $700 base + $200 tax + $100 surcharge = $1,000 across three
 * passengers. Divide each column separately and passenger 1 gets
 * 233.34 + 66.67 + 33.34 = 333.35 — but their selling price, divided from
 * the $1,000 on its own line, is 333.34. Every column adds up perfectly and
 * yet the ticket contradicts itself by a cent. Cancel that passenger and the
 * refund arithmetic has two different answers.
 *
 * So the components are split, and the totals that are *made of* those
 * components are rebuilt from the parts rather than divided again:
 *
 *     cost_price    = base + tax
 *     selling_price = base + tax + surcharge
 *
 * That holds only when the booking's own totals agree with its components,
 * which is the normal case — the form derives them exactly that way. When
 * someone has overridden the selling price by hand so it no longer equals
 * base + tax + surcharge, the components cannot explain it, and rebuilding
 * would silently change the price the customer was quoted. In that case the
 * total is divided on its own line instead: the ticket then carries the same
 * discrepancy the booking already had, which is honest, rather than a
 * different price, which is not.
 *
 * @param {object} totals  base_price, tax, surcharge, cost_price,
 *                         selling_price, agent_commission
 * @param {number} n
 * @returns {Array<object>} one share per passenger
 */
const splitBooking = (totals, n) => {
  const t = (k) => Number(totals[k]) || 0;

  // Independent quantities: nothing is derived from anything else here.
  const parts = splitAmounts(
    {
      base_price: t("base_price"),
      tax: t("tax"),
      surcharge: t("surcharge"),
      agent_commission: t("agent_commission"),
    },
    n,
  );

  const costIsDerived =
    toCents(t("cost_price")) === toCents(t("base_price")) + toCents(t("tax"));
  const sellingIsDerived =
    toCents(t("selling_price")) ===
    toCents(t("base_price")) + toCents(t("tax")) + toCents(t("surcharge"));

  const costFallback = costIsDerived ? null : splitAmount(t("cost_price"), n);
  const sellingFallback = sellingIsDerived
    ? null
    : splitAmount(t("selling_price"), n);

  return parts.map((p, i) => ({
    ...p,
    cost_price: costIsDerived
      ? toMoney(toCents(p.base_price) + toCents(p.tax))
      : costFallback[i],
    selling_price: sellingIsDerived
      ? toMoney(toCents(p.base_price) + toCents(p.tax) + toCents(p.surcharge))
      : sellingFallback[i],
  }));
};

/**
 * Spread one payment across several tickets, in proportion to what each
 * costs.
 *
 * A customer pays $345 against a $350 booking for two people. Settling the
 * tickets in order leaves the first paid in full and the whole $5 shortfall
 * sitting on the second passenger — which reads, on the Tickets page, as
 * though one traveller has paid and the other has not. Nobody agreed to
 * that; the money was handed over for the booking, not for a seat.
 *
 * Pro rata instead: each ticket receives its share of what was paid, so a
 * booking that is 98.6% paid leaves every seat 98.6% paid. The shortfall is
 * visible where it belongs — spread across the booking — and no passenger is
 * singled out by an ordering they never chose.
 *
 * The cents are handled the same way as the price split: floor everything,
 * then hand the remainder out one cent at a time to whoever was rounded down
 * hardest, so the allocation adds up to the payment exactly.
 *
 * @param {number} paidCents        what was actually collected, in cents
 * @param {number[]} priceCents     each ticket's price, in cents
 * @returns {number[]}              cents allocated to each, summing to paidCents
 */
const allocateProRata = (paidCents, priceCents) => {
  const total = priceCents.reduce((a, p) => a + p, 0);
  const n = priceCents.length;
  if (n === 0 || paidCents <= 0) return priceCents.map(() => 0);

  // Nothing priced, or paying the lot: hand each ticket its own price and
  // avoid dividing by zero on the way.
  if (total <= 0) return priceCents.map(() => 0);
  if (paidCents >= total) return [...priceCents];

  const exact = priceCents.map((p) => (paidCents * p) / total);
  const floors = exact.map(Math.floor);
  let spare = paidCents - floors.reduce((a, f) => a + f, 0);

  // Largest fractional part first — the ticket that lost the most to
  // rounding gets the spare cent back. Ties break on the earlier ticket, so
  // the same booking always allocates identically.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floors];
  for (let k = 0; k < order.length && spare > 0; k++) {
    // Never push a ticket past its own price: the surplus would look like an
    // overpayment on a seat nobody overpaid for.
    if (out[order[k].i] < priceCents[order[k].i]) {
      out[order[k].i] += 1;
      spare -= 1;
    }
  }
  return out;
};

/**
 * Does a set of shares still add up? Used by the tests and as a last-line
 * assertion before anything is written, because the one failure mode that
 * must never reach the database is silent.
 */
const sumsTo = (parts, total) =>
  parts.reduce((a, p) => a + toCents(p), 0) === toCents(total);

module.exports = {
  splitAmount,
  splitAmounts,
  splitBooking,
  allocateProRata,
  sumsTo,
  toCents,
  toMoney,
};
