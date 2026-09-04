/**
 * invoice.js — the look of every document TAMS hands to a customer.
 *
 * The stylesheet, the paper sizes and the print plumbing live here rather
 * than inside one page, because a customer invoice and a cargo receipt from
 * the same agency should not be two different-looking documents that drift
 * apart every time one of them is touched.
 *
 * Type sizes were raised across the board, twice. The original set was tuned
 * to fit a long statement on one sheet, which made a printed invoice hard to
 * read at arm's length — and being read is the entire job of the thing.
 * Everything is now roughly 1.55x the first version.
 *
 * The masthead heights and row padding were raised with the type rather than
 * left alone: bigger words inside the same boxes only makes a page look
 * cramped, which reads as worse, not clearer.
 *
 * A long statement may now run to a second sheet. That is the right trade —
 * a customer squinting at one page is worse than a customer reading two.
 */

const INV_CSS = `
  :root{
    --teal:#0F766E; --teal-deep:#134E4A; --teal-soft:#5EEAD4; --teal-pale:#F0FDFA;
    --slate:#0F172A; --body:#334155; --muted:#64748B; --line:#E2E8F0;
    --rowalt:#F8FAFC; --green:#15803D; --red:#B91C1C;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    font-family:Arial,Helvetica,sans-serif; color:var(--body); font-size:17.9px;
    padding:29px 34px 0;
    /* Without this most browsers drop every background when printing, and
       the invoice comes out as white boxes with white text in them. */
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }

  /* ── Masthead: mark, name, stamp — one row, read left to right ────────
     Who this is from, then what it is. The stamp is pushed right and kept
     narrow so the middle slot, which holds a name of unknown length, gets
     the room. INVOICE is eight fixed characters; a business name is not. */
  .band{display:flex;align-items:stretch;height:82px;overflow:hidden}
  .brand{display:flex;align-items:center;flex-shrink:0;max-width:250px}
  .brand img{max-height:72px;max-width:240px;object-fit:contain}
  .mark{width:72px;height:72px;border-radius:8px;background:var(--teal);color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:34.3px;font-weight:bold;flex-shrink:0}
  /* The one element on the page that is purely the agency's, so the one
     worth setting like a wordmark rather than like data. */
  .agency{
    flex:1;min-width:0;display:flex;align-items:center;padding:0 14px;
    font-family:Georgia,"Times New Roman",Times,serif;font-weight:bold;font-size:23.4px;
    line-height:1.15;
  }
  .agency .nm{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .agency .a{color:var(--teal)}
  .agency .b{color:var(--slate)}
  .slash{width:13px;background:var(--teal);transform:skewX(-19deg);margin-right:7px;flex-shrink:0}
  .slash.soft{background:var(--teal-soft)}
  .stamp{width:150px;background:var(--teal);transform:skewX(-19deg);flex-shrink:0;
         display:flex;align-items:center;justify-content:flex-end;margin-right:-30px;padding-right:42px}
  .stamp span{transform:skewX(19deg);color:#fff;font-size:18.7px;font-weight:bold;letter-spacing:2.5px}
  .rule{height:3px;background:var(--teal);margin:8px 0 15px}

  .cols{display:flex;gap:30px}
  .cols>div{flex:1;min-width:0}
  .right{text-align:right}
  h2{font-size:15.6px;color:var(--teal);margin:0 0 7px;display:inline-block;
     border-bottom:1px solid var(--teal);padding-bottom:2px}
  .hwrap{margin-bottom:7px}
  /* Wraps rather than truncating. At the old type size a long name fitted on
     one line; at this one it would be cut off with an ellipsis, and half a
     customer's name on an invoice is worse than a taller box. */
  .kv{font-size:14.8px;line-height:1.6;overflow-wrap:anywhere}
  .kv b{color:var(--slate)}

  /* ── Service costs: the block the customer actually reads ────────────── */
  .tablewrap{border:1.6px solid var(--teal);border-radius:7px;overflow:hidden;background:var(--teal-pale)}
  table{width:100%;border-collapse:collapse;font-size:14.1px;table-layout:fixed}
  thead th{background:var(--teal);color:#fff;text-align:left;padding:6px;
           font-size:11.8px;letter-spacing:.4px;text-transform:uppercase;font-weight:bold}
  tbody td{padding:5.5px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  tbody tr:nth-child(odd) td{background:#fff}
  td.who{font-weight:bold;color:var(--slate)}
  td.num{text-align:right}
  td.owing{color:var(--red);font-weight:bold}
  td.clear{color:var(--green);font-weight:bold}
  td.none{text-align:center;color:var(--muted);padding:13px}

  .panels{display:flex;gap:14px;margin-top:15px;align-items:flex-start}
  .receipts{flex:1;min-width:0;background:var(--teal-pale);border:1px solid var(--line);
            border-radius:6px;padding:12px 14px;min-height:78px}
  .receipts .rh{font-size:12.5px;font-weight:bold;color:var(--teal-deep);letter-spacing:.6px;
                display:flex;justify-content:space-between;margin-bottom:6px}
  .receipts table{font-size:13.3px}
  .receipts td{border:0;padding:2.5px 0;background:transparent}
  .receipts tr:nth-child(odd) td{background:transparent}
  .empty{text-align:center;padding:22px 7px;color:var(--muted)}
  .empty b{display:block;color:var(--body);font-size:15.6px;margin-bottom:3px}
  .totals{width:210px;flex-shrink:0}
  .totals div{display:flex;justify-content:space-between;align-items:center;
              padding:6.5px 13px;color:#fff;background:var(--teal)}
  .totals div:nth-child(2){background:#128077}
  /* Money held for the customer, subtracted in front of them. Green because
     it is the one row on the panel that counts in their favour, and it must
     not be mistaken for another charge. */
  .totals div.credit{background:var(--green)}
  .totals div.strong{background:var(--teal-deep)}
  .totals span.l{font-size:13.3px;font-weight:bold;letter-spacing:.5px}
  .totals span.v{font-size:16.4px;font-weight:bold}
  .totals div.strong span.v{font-size:18.7px}
  .note{font-size:11.8px;color:var(--muted);margin-top:8px}

  /* ── Payment methods: the bank's own mark leads, the number is the text ──
     White throughout, including behind the mark. A bank's logo is drawn to
     sit on white; putting it on a tint changes the colour it was designed
     against, and on the two-colour marks most Somali banks use it looks
     like a printing fault. The teal edge is a border, not a background. */
  .methods{display:flex;flex-wrap:wrap;gap:9px;margin-top:3px}
  .method{width:calc((100% - 18px)/3);display:flex;align-items:center;
          border:1.1px solid var(--teal-soft);border-radius:8px;overflow:hidden;
          background:#fff;box-shadow:2px 2.5px 0 var(--teal-pale)}
  .method .panel{width:42px;flex-shrink:0;background:#fff;
                 border-left:3.5px solid var(--teal);align-self:stretch;
                 display:flex;align-items:center;justify-content:center}
  .method .panel img{max-width:26px;max-height:26px;object-fit:contain}
  .method .panel .ini{font-size:17.2px;font-weight:bold;color:var(--teal)}
  .method .body{padding:8px 11px;min-width:0;flex:1}
  .method .num{font-size:14.8px;font-weight:bold;color:var(--slate);
               white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .method .hold{font-size:10.9px;color:var(--muted);margin-top:2px;
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  /* ── Tracking strip: how to find the parcel without phoning the office ──
     Somali first. The person holding this receipt is being told how to do
     something, and instructions in a second language are instructions that
     do not get followed. The English underneath is one line, for whoever
     else ends up holding the paper.

     Dashed edge and a tinted ground so it reads as a coupon rather than as
     more of the invoice — it is the one block on the page that asks the
     customer to go and do something. */
  .track{margin-top:14px;border:1.6px dashed var(--teal);border-radius:8px;
         background:var(--teal-pale);padding:11px 14px}
  .track .th{display:flex;align-items:baseline;gap:9px;margin-bottom:7px}
  .track .th b{font-size:15.6px;color:var(--teal-deep);letter-spacing:.4px}
  .track .th span{font-size:11.8px;color:var(--muted)}
  .track .tb{display:flex;gap:14px;align-items:stretch}
  .track ol{flex:1;min-width:0;margin:0;padding-left:17px}
  .track li{font-size:13.6px;line-height:1.62;color:var(--body);overflow-wrap:anywhere}
  .track li b{color:var(--slate)}
  /* The two things a customer copies. Set apart from the prose so they can
     be found by someone squinting at a folded receipt. */
  .track .q{display:inline-block;background:#fff;border:1px solid var(--teal-soft);
            border-radius:4px;padding:0 5px;font-weight:bold;color:var(--teal-deep)}
  .track .tcard{width:196px;flex-shrink:0;background:#fff;border:1.4px solid var(--teal);
                border-radius:7px;padding:9px 10px;text-align:center;
                display:flex;flex-direction:column;justify-content:center}
  .track .tl{font-size:9.6px;font-weight:bold;color:var(--teal);letter-spacing:.9px}
  .track .tn{font-size:20.5px;font-weight:bold;color:var(--slate);margin:3px 0 4px;
             overflow-wrap:anywhere;line-height:1.15}
  .track .tu{font-size:11.2px;color:var(--muted);overflow-wrap:anywhere;line-height:1.4}
  .track .en{font-size:11.2px;color:var(--muted);margin-top:8px;overflow-wrap:anywhere}

  .sign{text-align:center;margin-top:16px}
  .sign .n{font-size:15.6px;font-weight:bold;color:var(--slate)}
  .sign .n span{font-weight:normal;color:var(--muted)}
  .sign .d{font-size:12.5px;color:var(--muted);margin-top:3px}

  /* ── Footer: the only place the contact details live ─────────────────── */
  .foot{margin-top:22px}
  .foot .ty{text-align:center;font-family:Georgia,"Times New Roman",Times,serif;
            font-style:italic;font-size:14.1px;color:var(--teal);margin-bottom:8px}
  .foot .fr{height:1.6px;background:var(--teal)}
  .foot .fc{display:flex;margin-top:9px}
  .foot .fc>div{flex:1;min-width:0;padding-right:10px;display:flex;gap:7px;align-items:flex-start}
  .disc{width:17px;height:17px;border-radius:50%;background:var(--teal);flex-shrink:0;
        display:flex;align-items:center;justify-content:center;margin-top:1px}
  .disc svg{width:11px;height:11px;display:block}
  .foot .ft{min-width:0}
  .foot .fl{font-size:10.1px;font-weight:bold;color:var(--teal);letter-spacing:.9px}
  .foot .fv{font-size:11.8px;color:var(--body);margin-top:1px;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .foot .gen{text-align:right;font-size:10.1px;color:var(--muted);margin-top:9px}

  section{page-break-inside:avoid}
  thead{display:table-header-group}
  tr{page-break-inside:avoid}

  /* The toolbar exists so the paper can be changed after the dialog has
     been dismissed once. It is never printed. */
  .bar{position:sticky;top:0;z-index:9;display:flex;gap:8px;align-items:center;
       padding:8px 0 12px;font-size:18.7px;color:var(--muted)}
  .bar button{font:inherit;padding:5px 14px;border-radius:6px;cursor:pointer;
              border:1px solid var(--line);background:#fff;color:var(--body)}
  .bar button.on{background:var(--teal);border-color:var(--teal);color:#fff;font-weight:bold}
  .bar .go{background:var(--slate);border-color:var(--slate);color:#fff}
  @media print{.bar{display:none !important}}
`;

/**
 * Make the invoice window work — from this window, not from inside it.
 *
 * The invoice opens as about:blank and is written into, so it inherits this
 * page's Content-Security-Policy. In production that policy forbids inline
 * script, which is deliberate: it is what stops an injected <script> in a
 * customer's name from ever running. It also, unavoidably, stopped the
 * invoice's own <script> block and its onclick="" handlers — so the Print
 * button did nothing and the dialog never opened. On a local dev server
 * there is no such policy, which is why it only ever failed in production.
 *
 * The fix is not to weaken the policy. A popup opened from here shares this
 * origin, so script already running here can reach into its DOM and attach
 * listeners; nothing inline is needed. Same behaviour, nothing relaxed.
 */
const wirePrintWindow = (win, paper) => {
  const doc = win.document;
  const setPaper = (size) => {
    const style = doc.getElementById("paper");
    if (style) style.textContent = PAPER_CSS[size] || PAPER_CSS.A4;
    const a4 = doc.getElementById("p-a4");
    const a5 = doc.getElementById("p-a5");
    if (a4) a4.className = size === "A4" ? "on" : "";
    if (a5) a5.className = size === "A5" ? "on" : "";
  };

  doc.getElementById("p-a4")?.addEventListener("click", () => setPaper("A4"));
  doc.getElementById("p-a5")?.addEventListener("click", () => setPaper("A5"));
  doc.getElementById("p-go")?.addEventListener("click", () => {
    win.focus();
    win.print();
  });

  setPaper(paper || "A4");

  // Wait for the logo and icons to paint before opening the dialog,
  // otherwise the first print of a session comes out with empty boxes.
  const go = () => {
    try {
      win.focus();
      win.print();
    } catch {
      // The user closed the window before it settled. Nothing to do.
    }
  };
  if (doc.readyState === "complete") setTimeout(go, 350);
  else win.addEventListener("load", () => setTimeout(go, 350));
};

const PAPER_CSS = {
  A4: `@page{size:A4;margin:10mm} body{zoom:1}`,
  A5: `@page{size:A5;margin:7mm} body{zoom:0.706}`,
};

// White glyphs on the teal disc. Inline SVG rather than an icon font so the
// page needs no network access at print time — the print window is opened
// with document.write and has nothing to fetch from.
const DISC_ICONS = {
  phone: `<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2.2" fill="#fff"/><rect x="10" y="4.2" width="4" height="1.2" fill="#0F766E"/><circle cx="12" cy="19" r="1.1" fill="#0F766E"/></svg>`,
  pin: `<svg viewBox="0 0 24 24"><path d="M12 2.2a6.8 6.8 0 0 0-6.8 6.8c0 5 6.8 12.8 6.8 12.8s6.8-7.8 6.8-12.8A6.8 6.8 0 0 0 12 2.2z" fill="#fff"/><circle cx="12" cy="9" r="2.5" fill="#0F766E"/></svg>`,
  mail: `<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2" fill="#fff"/><path d="M3.6 6.6 12 12.7l8.4-6.1" fill="none" stroke="#0F766E" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The public address of this installation, as a customer would type it.
 *
 * Taken from the browser rather than from a build-time variable: the receipt
 * is printed from the live site, so the address in the address bar is by
 * definition the one that works. A configured constant is one deployment
 * away from printing an address that does not.
 */
const siteHost = (override) => {
  const raw =
    override ||
    (typeof window !== "undefined" ? window.location.origin : "") ||
    "";
  return raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
};

/**
 * trackingStrip — how to find the parcel, printed on the parcel's receipt.
 *
 * The tracking page has existed for a while and almost nobody used it,
 * because nothing the customer was handed ever mentioned it. They phoned the
 * office instead. This is the fix, and it belongs on paper rather than in
 * the app: the receipt is the one thing that goes home with them.
 *
 * Written in Somali first. The person holding this is being told how to do
 * something, and instructions in a language they read second are
 * instructions that do not get followed. One English line follows for
 * whoever else ends up with the paper.
 *
 * Three routes are given, in order of how likely each is to work:
 *
 *   1. the address typed straight in — always works, needs no index
 *   2. the direct link with the number already in it — one tap from WhatsApp
 *   3. a search, agency name included, which is the query that can actually
 *      rank; "raadi alaabtaada" alone competes with every Somali site using
 *      two ordinary words
 *
 * @param {object} args
 * @param {string} args.brand           the agency's name, for the search
 * @param {string} [args.trackingNumber]
 * @param {string} [args.siteUrl]       override, for a different domain
 */
const trackingStrip = ({ brand, trackingNumber, siteUrl } = {}) => {
  const host = siteHost(siteUrl);
  if (!host) return ""; // nothing sensible to print
  const name = String(brand || "").trim();
  const num = String(trackingNumber || "").trim();
  const search = [name, "raadi alaabtaada"].filter(Boolean).join(" ");
  const direct = num ? `${host}/track/${num}` : `${host}/track`;

  return `<section class="track">
    <div class="th"><b>RAADI ALAABTAADA</b><span>Track your shipment</span></div>
    <div class="tb">
      <ol>
        <li>Fur Google ama browser kasta oo taleefankaaga ku jira.</li>
        <li>Ku qor cinwaankan: <span class="q">${esc(host)}/track</span>
            ama raadi <span class="q">${esc(search)}</span>.</li>
        <li>Geli lambarka raadraaca${
          num ? ` — <b>${esc(num)}</b>` : ""
        } ka dibna riix <b>Raadi</b>.</li>
        <li>Waxaad arki doontaa halka ay alaabtaadu maanta joogto, xafiiska
            haya, iyo lambarka aad wacdo.</li>
      </ol>
      <div class="tcard">
        <div class="tl">LAMBARKA RAADRAACA</div>
        <div class="tn">${esc(num || "—")}</div>
        <div class="tu">${esc(direct)}</div>
      </div>
    </div>
    <div class="en">Track your shipment: open <b>${esc(host)}/track</b> and enter
      ${num ? `<b>${esc(num)}</b>` : "your tracking number"}, or go straight to
      <b>${esc(direct)}</b>. Keep this number — it is the only one we can look up.</div>
  </section>`;
};

export {
  INV_CSS,
  PAPER_CSS,
  DISC_ICONS,
  esc,
  wirePrintWindow,
  trackingStrip,
  siteHost,
};
