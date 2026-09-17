#!/usr/bin/env node
/**
 * seo.js — make the public pages findable, and describable.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * TAMS is a single-page app: nginx serves the same index.html for every URL
 * and React decides what to draw. Two consequences, both bad for a domain
 * that has a public face:
 *
 *   1. Every URL shares one <title>, so /track was advertised to searchers
 *      as "TAMS — Travel Agency Management System".
 *   2. The words that describe the business only exist after JavaScript has
 *      run. Google renders JS eventually; the crawlers behind AI assistants
 *      mostly do not. A page whose content appears a second later is a page
 *      they describe as blank.
 *
 * WHAT IT DOES
 *
 * After the build, it writes a copy of index.html for each public page with
 * that page's own title, description, structured data — and a block of plain
 * HTML inside #root, which React replaces the instant it mounts but which a
 * crawler that never runs JavaScript reads as the content of the page. That
 * last part is the difference between "no information is available" and a
 * search result that says what the business does.
 *
 * It also generates robots.txt and sitemap.xml. Those were static files
 * naming a hardcoded domain, which survived a migration and went on pointing
 * search engines at a server that was being switched off. Anything carrying
 * the site's address is generated from the site's address.
 *
 * Configure per deployment:
 *   REACT_APP_SITE_URL     https://socdaalhub.com
 *   REACT_APP_TRACK_BRAND  Socdaal Hub
 */

const fs = require("fs");
const path = require("path");

const BUILD = path.join(__dirname, "..", "build");
const SITE = (process.env.REACT_APP_SITE_URL || "https://socdaalhub.com").replace(/\/$/, "");
const BRAND = process.env.REACT_APP_TRACK_BRAND || "Socdaal Hub";
const HOST = SITE.replace(/^https?:\/\//, "");

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

// ── What each public page says about itself ────────────────────────────────
//
// Somali first on the tracking page, because the person looking for a parcel
// is searching in Somali. English follows so the result still means
// something to everyone else.
const PAGES = {
  track: {
    dir: "track",
    title: `Raadi Alaabtaada — ${BRAND}`,
    description:
      `Raadi alaabtaada. Geli lambarka raadraaca oo arag halka ay maanta ` +
      `taallo, xafiiska ay ku jirto iyo lambarka aad la xiriirto. Track your ` +
      `cargo with ${BRAND} — enter your tracking number to see where your ` +
      `shipment is, which office holds it, and who to call.`,
    body: `
      <h1>Raadi alaabtaada</h1>
      <p>Track your shipment with ${escapeHtml(BRAND)}. Geli lambarka
         raadraaca ee warqaddaada ku qoran.</p>
      <p>You will see where your shipment is today, which office is holding
         it, and the phone number to call about it.</p>
      <p>${escapeHtml(BRAND)} is a travel agency management system used by
         agencies in Mogadishu and across Somalia for flight tickets, visas,
         Hajj and Umrah packages, and cargo.
         Contact: info@${escapeHtml(HOST)}</p>`,
  },
};

/**
 * Structured data.
 *
 * Organization is what lets a search engine treat the site as a business
 * with a name, a logo and a place, rather than a URL it happened to find. It
 * is a prerequisite for the logo appearing beside a result — not a guarantee
 * of it, which is worth saying plainly because plenty of people sell it as
 * one.
 *
 * `name` is exactly the brand, everywhere, because a business referred to
 * three ways is three weak signals instead of one strong one.
 */
const structuredData = () => {
  const org = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: BRAND,
    url: `${SITE}/`,
    logo: `${SITE}/favicon.svg`,
    description:
      `${BRAND} is a travel agency management system used by agencies in ` +
      `Mogadishu and across Somalia for flight tickets, visas, Hajj and ` +
      `Umrah packages, and cargo.`,
    email: `info@${HOST}`,
    address: {
      "@type": "PostalAddress",
      addressLocality: "Mogadishu",
      addressCountry: "SO",
    },
    areaServed: "SO",
  };

  const site = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: BRAND,
    url: `${SITE}/`,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE}/track/{tracking_number}`,
      },
      "query-input": "required name=tracking_number",
    },
  };

  // The tracking page is the only public one, so it carries both: it is the
  // single place that identifies the business to a search engine.
  return [org, site];
};

const headFor = (key) => {
  const p = PAGES[key];
  const url = `${SITE}/${key}`;
  return `
    <title>${escapeHtml(p.title)}</title>
    <meta name="description" content="${escapeHtml(p.description)}" />
    <link rel="canonical" href="${url}" />
    <meta name="robots" content="index, follow" />

    <!-- What WhatsApp, Facebook and Telegram show when the link is pasted.
         Most customers meet this domain as a shared link, not a search
         result, so the preview matters at least as much as the SEO. -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${escapeHtml(BRAND)}" />
    <meta property="og:title" content="${escapeHtml(p.title)}" />
    <meta property="og:description" content="${escapeHtml(p.description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:locale" content="so_SO" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(p.title)}" />
    <meta name="twitter:description" content="${escapeHtml(p.description)}" />

    <script type="application/ld+json">
${JSON.stringify(structuredData(key), null, 2)}
    </script>`;
};

const writePage = (key, template) => {
  const p = PAGES[key];
  let html = template
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\s+name="description"[^>]*>/i, "")
    .replace(/<\/head>/i, `${headFor(key)}\n  </head>`);

  // The fallback content goes INSIDE #root. React empties that element when
  // it mounts, so a visitor never sees it for a frame longer than the app
  // takes to start — while a crawler that runs no JavaScript reads it as the
  // whole page. Putting it anywhere else would leave it on screen underneath
  // the real app.
  html = html.replace(
    /<div id="root">\s*<\/div>/i,
    `<div id="root">${p.body}</div>`,
  );

  const outDir = path.join(BUILD, p.dir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  return path.relative(BUILD, path.join(outDir, "index.html"));
};

const main = () => {
  const indexPath = path.join(BUILD, "index.html");
  if (!fs.existsSync(indexPath)) {
    console.error("[seo] No build/index.html — run the build first.");
    process.exit(1);
  }
  const template = fs.readFileSync(indexPath, "utf8");

  if (!/<div id="root">\s*<\/div>/i.test(template)) {
    // Loud rather than silent: without this the crawler fallback is dropped
    // and the only symptom is a search result that says nothing, months later.
    console.warn(
      '[seo] WARNING: could not find an empty <div id="root"></div> — ' +
        "crawler fallback text was NOT injected.",
    );
  }

  const trackOut = writePage("track", template);

  // ── robots.txt ──
  //
  // The tracking page is the only public one. The domain root is the staff
  // login screen, so it stays out: a search result reading "Sign in to your
  // account" tells a customer nothing and invites crawlers to hammer an
  // authentication endpoint.
  //
  // Consequence, so it is not a surprise later: a brand search for the bare
  // domain will keep showing "No information is available for this page",
  // because that is what Google prints for a URL it may not read. Only a
  // crawlable page at / changes that.
  fs.writeFileSync(
    path.join(BUILD, "robots.txt"),
    `# The tracking page is meant to be found: a customer who has lost their
# receipt should be able to search for it. Everything else is the agencies'
# private system and has no business in a search index.

User-agent: *
Allow: /track
Allow: /favicon.svg
Allow: /static/
Disallow: /

Sitemap: ${SITE}/sitemap.xml
`,
  );

  // ── sitemap.xml ──
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(BUILD, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated at build time from REACT_APP_SITE_URL. Hardcoding the domain
     here is how a sitemap survives a migration still naming the old one. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE}/track</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`,
  );

  console.log(`[seo] brand:     ${BRAND}`);
  console.log(`[seo] site:      ${SITE}`);
  console.log(`[seo] wrote:     ${trackOut}, robots.txt, sitemap.xml`);
  console.log(`[seo] track:     ${PAGES.track.title}`);
};

main();
