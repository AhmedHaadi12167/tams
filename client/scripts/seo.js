#!/usr/bin/env node
/**
 * seo.js — give the public tracking page a real identity in search results.
 *
 * THE PROBLEM
 *
 * TAMS is a single-page app: nginx serves the same index.html for every URL
 * and React decides what to draw. That means /track shares its <title> and
 * description with the login screen — so even once Google finds the page, the
 * result reads "TAMS — Travel Agency Management System", which means nothing
 * to a customer looking for their parcel.
 *
 * Setting the title from React fixes the browser tab but not the search
 * result reliably: crawlers do run JavaScript now, but they decide what to
 * show from the HTML they are served first, and a title that appears a second
 * later is a coin flip.
 *
 * THE FIX
 *
 * After the build, write a second copy of index.html at build/track/index.html
 * with the tracking page's own title, description and social-preview tags.
 * nginx serves that file for /track (it matches before the SPA fallback), so
 * a crawler receives the right metadata in the first response, while the
 * React app still boots and takes over exactly as before.
 *
 * No prerendering framework, no server-side rendering, no second build. One
 * file, written after the fact.
 *
 * Configure per deployment:
 *   REACT_APP_SITE_URL     https://tams.ecosagency.com
 *   REACT_APP_TRACK_BRAND  Mubah Travel
 */

const fs = require("fs");
const path = require("path");

const BUILD = path.join(__dirname, "..", "build");
const SITE = (process.env.REACT_APP_SITE_URL || "https://tams.ecosagency.com").replace(/\/$/, "");
const BRAND = process.env.REACT_APP_TRACK_BRAND || "Mubah Travel";

// Somali first, because the people searching for a parcel are searching in
// Somali. The English follows so the result still makes sense to anyone else.
const TITLE = `Raadi Alaabtaada — ${BRAND}`;
const DESCRIPTION =
  `Raadi alaabtaada. Geli lambarka raadraaca oo arag halka ay maanta taallo, ` +
  `xafiiska ay ku jirto iyo lambarka aad la xiriirto. ` +
  `Track your cargo with ${BRAND} — enter your tracking number to see where ` +
  `your shipment is, which office holds it, and who to call.`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

const head = `
    <title>${escapeHtml(TITLE)}</title>
    <meta name="description" content="${escapeHtml(DESCRIPTION)}" />
    <link rel="canonical" href="${SITE}/track" />
    <meta name="robots" content="index, follow" />

    <!-- What WhatsApp, Facebook and Telegram show when the link is pasted.
         Most customers will meet this page as a shared link, not a search
         result, so the preview matters at least as much as the SEO. -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${escapeHtml(BRAND)}" />
    <meta property="og:title" content="${escapeHtml(TITLE)}" />
    <meta property="og:description" content="${escapeHtml(DESCRIPTION)}" />
    <meta property="og:url" content="${SITE}/track" />
    <meta property="og:locale" content="so_SO" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(TITLE)}" />
    <meta name="twitter:description" content="${escapeHtml(DESCRIPTION)}" />

    <!-- Tells Google this is a thing with a search box, which is what earns
         the "Track Your Shipments" style result rather than a bare link. -->
    <script type="application/ld+json">
${JSON.stringify(
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: BRAND,
    url: SITE,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE}/track/{tracking_number}`,
      },
      "query-input": "required name=tracking_number",
    },
  },
  null,
  2,
)}
    </script>`;

const main = () => {
  const indexPath = path.join(BUILD, "index.html");
  if (!fs.existsSync(indexPath)) {
    console.error("[seo] No build/index.html — run the build first.");
    process.exit(1);
  }

  let html = fs.readFileSync(indexPath, "utf8");

  // Replace the app's own title and description rather than appending a
  // second one: two <title> tags is undefined behaviour and crawlers pick
  // whichever they like.
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\s+name="description"[^>]*>/i, "")
    .replace(/<\/head>/i, `${head}\n  </head>`);

  const outDir = path.join(BUILD, "track");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), html);

  console.log(`[seo] build/track/index.html written`);
  console.log(`[seo]   title: ${TITLE}`);
  console.log(`[seo]   canonical: ${SITE}/track`);
};

main();
