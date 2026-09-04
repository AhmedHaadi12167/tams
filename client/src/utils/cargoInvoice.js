/**
 * cargoInvoice.js — the receipt a cargo customer is handed.
 *
 * Deliberately the same document as the ticket invoice: same stylesheet,
 * same masthead, same totals block, same footer. A customer who ships a
 * parcel one week and books a flight the next should recognise the paper.
 *
 * What differs is only what a parcel has and a seat does not — a tracking
 * number, a weight, and where it has landed — so those replace the flight
 * columns rather than being bolted on beside them.
 */

import { INV_CSS, PAPER_CSS, DISC_ICONS, esc, wirePrintWindow } from "./invoice";

const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;

const fmt = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
};

/** Initials for the lettermark used when no logo has been uploaded. */
const brandInitials = (name) => {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "TA";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

/**
 * @param {object} shipment  the cargo row, as the API returns it
 * @param {object} business  name, logo, address, phone, email, website
 * @param {Array}  payments  cargo_payments rows, newest first
 * @param {object} [options] { paper, preparedBy, logoUrl }
 */
export const buildCargoInvoice = (
  shipment,
  business = {},
  payments = [],
  options = {},
) => {
  const paper = options.paper || "A4";
  const total = Number(shipment.total_price) || 0;
  const paid = Number(shipment.amount_paid) || 0;
  const balance = Math.round((total - paid) * 100) / 100;

  const nameParts = String(business.name || "Travel Agency").trim().split(/\s+/);
  const nameHead = nameParts[0] || "";
  const nameTail = nameParts.slice(1).join(" ");

  const brand = options.logoUrl
    ? `<img src="${esc(options.logoUrl)}" alt="" />`
    : `<div class="mark">${esc(brandInitials(business.name))}</div>`;

  const contacts = [
    ["phone", "Call", business.phone],
    ["pin", "Visit", business.address],
    [
      "mail",
      "Online",
      [business.email, business.website].filter(Boolean).join("  ·  "),
    ],
  ].filter(([, , v]) => v);

  // Weight and rate only when the shipment was priced that way. A parcel
  // charged a flat price has no per-kilo figure, and printing "0.00/kg"
  // invites a question the receipt cannot answer.
  const pricing =
    Number(shipment.weight_kg) > 0 && Number(shipment.price_per_kg) > 0
      ? `${Number(shipment.weight_kg).toFixed(2)} kg × ${money(shipment.price_per_kg)}`
      : "Flat price";

  const arrived = shipment.arrived_city
    ? `<div class="kv"><b>Arrived:</b> ${esc(shipment.arrived_city)}${
        shipment.arrived_office ? ` — ${esc(shipment.arrived_office)}` : ""
      }${shipment.arrived_phone ? ` · ${esc(shipment.arrived_phone)}` : ""}</div>`
    : "";

  const receipts = payments.length
    ? `<div class="receipts">
         <div class="rh">RECEIPTS</div>
         <table>
           ${payments
             .map(
               (p) => `<tr>
                 <td>${esc(fmt(p.created_at))}</td>
                 <td>${esc(shipment.sender_name)}</td>
                 <td style="text-align:right">${esc(p.account_name || p.method || "")}</td>
                 <td style="text-align:right">${money(p.amount)}</td>
               </tr>`,
             )
             .join("")}
         </table>
       </div>`
    : `<div class="empty"><b>No payments yet</b>This shipment has not been paid for.</div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <title>Cargo receipt — ${esc(shipment.tracking_number || shipment.sender_name)}</title>
    <style>${INV_CSS}</style>
    <style id="paper">${PAPER_CSS[paper] || PAPER_CSS.A4}</style></head><body>

    <div class="bar">
      <span>Paper</span>
      <button type="button" id="p-a4" class="on">A4</button>
      <button type="button" id="p-a5">A5</button>
      <button type="button" id="p-go" class="go">Print</button>
    </div>

    <div class="band">
      <div class="brand">${brand}</div>
      <div class="agency"><div class="nm"><span class="a">${esc(nameHead)}</span><span class="b">${esc(nameTail)}</span></div></div>
      <div class="slash soft"></div>
      <div class="slash"></div>
      <div class="stamp"><span>CARGO</span></div>
    </div>

    <section class="meta">
      <div>
        <h2>Shipped By</h2>
        <div class="kv"><b>Sender:</b> ${esc(shipment.sender_name)}</div>
        <div class="kv"><b>Contact:</b> ${esc(shipment.sender_contact || "—")}</div>
        <div class="kv"><b>From:</b> ${esc(shipment.from_city)}</div>
      </div>
      <div>
        <h2>Delivered To</h2>
        <div class="kv"><b>Receiver:</b> ${esc(shipment.receiver_name)}</div>
        <div class="kv"><b>Contact:</b> ${esc(shipment.receiver_contact || "—")}</div>
        <div class="kv"><b>To:</b> ${esc(shipment.to_city)}</div>
      </div>
      <div class="right">
        <h2>Shipment</h2>
        <div class="kv"><b>Tracking:</b> ${esc(shipment.tracking_number || "—")}</div>
        <div class="kv"><b>Booked:</b> ${esc(fmt(shipment.created_at))}</div>
        <div class="kv"><b>Status:</b> ${esc(String(shipment.cargo_status || "").toUpperCase())}</div>
        ${arrived}
      </div>
    </section>

    <h2>Charges</h2>
    <table>
      <thead>
        <tr>
          <th style="width:6%">SN</th>
          <th style="width:34%">ITEM</th>
          <th style="width:24%">PRICING</th>
          <th style="width:18%">TRACKING</th>
          <th style="width:9%;text-align:right">TOTAL</th>
          <th style="width:9%;text-align:right">BALANCE</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>1</td>
          <td><b>${esc(shipment.item_description || "Cargo")}</b></td>
          <td>${esc(pricing)}</td>
          <td>${esc(shipment.tracking_number || "—")}</td>
          <td style="text-align:right">${money(total)}</td>
          <td style="text-align:right" class="${balance > 0 ? "due" : ""}">${money(balance)}</td>
        </tr>
      </tbody>
    </table>

    <section class="split">
      ${receipts}
      <div class="totals">
        <div><span class="l">TOTAL</span><span class="v">${money(total)}</span></div>
        <div><span class="l">RECEIVED</span><span class="v">${money(paid)}</span></div>
        <div class="strong"><span class="l">BALANCE</span><span class="v">${money(balance)}</span></div>
      </div>
    </section>

    ${
      options.preparedBy
        ? `<div class="sign">
             <div class="n">${esc(options.preparedBy.name)}${
               options.preparedBy.title
                 ? `, <span style="font-weight:normal">${esc(options.preparedBy.title)}</span>`
                 : ""
             }</div>
             <div class="d">${esc(new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</div>
           </div>`
        : ""
    }

    <section class="foot">
      <div class="ty">Thank you for your business</div>
      <div class="fr"></div>
      <div class="fc">${contacts
        .map(
          ([glyph, l, v]) =>
            `<div><div class="disc">${DISC_ICONS[glyph]}</div>
               <div class="ft"><div class="fl">${l.toUpperCase()}</div><div class="fv">${esc(v)}</div></div>
             </div>`,
        )
        .join("")}</div>
      <div class="gen">generated ${esc(new Date().toLocaleString("en-GB"))}</div>
    </section>

    </body></html>`;
};

/**
 * Open the receipt in its own window, ready to print or save as PDF.
 *
 * "Download as PDF" is the browser's own print dialog with "Save as PDF"
 * chosen as the destination — the same document, no second code path to
 * keep in step, and it works on every machine without a server round trip.
 */
export const printCargoInvoice = (shipment, business, payments, options = {}) => {
  const html = buildCargoInvoice(shipment, business, payments, options);
  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  wirePrintWindow(win, options.paper || "A4");
  return true;
};
