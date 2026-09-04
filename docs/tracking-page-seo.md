# Getting "Raadi Alaabtaada" into Google

What was built, what you have to do, and what nobody can promise.

## What the code now does

`npm run build` runs one extra step afterwards (`scripts/seo.js`). It writes a
second copy of `index.html` to `build/track/index.html` carrying the tracking
page's own metadata:

```html
<title>Raadi Alaabtaada — Mubah Travel</title>
<meta name="description" content="Raadi alaabtaada. Geli lambarka raadraaca…" />
<link rel="canonical" href="https://tams.ecosagency.com/track" />
```

TAMS is a single-page app, so nginx normally serves the *same* `index.html` for
every URL and React decides what to draw. That means `/track` shared its title
with the login screen — a search result reading "TAMS — Travel Agency
Management System", which means nothing to somebody looking for their parcel.

Setting the title from React fixes the browser tab but not the search result
reliably. Crawlers do run JavaScript, but they decide what to display from the
HTML in the first response; a title that appears a second later is a coin flip.
Serving a real file for `/track` removes the coin flip.

Also added:

- `public/favicon.svg` — the mark beside the result. Google needs an icon of at
  least 48×48 that it can crawl.
- `public/robots.txt` — allows `/track`, **disallows everything else**. The rest
  of TAMS is the agency's private system and has no business in an index.
- `public/sitemap.xml` — the one public page.
- Structured data (`WebSite` + `SearchAction`) so Google can understand this as
  a thing with a tracking search box.
- Open Graph tags, so pasting the link into WhatsApp shows a proper preview
  rather than a bare URL. **Most customers will meet this page as a shared
  link, not a search result — this part matters at least as much as the SEO.**

## One nginx change is required

`/track/index.html` only gets served if nginx looks for it. Find the tracking
site's `location /` block and make sure it tries the directory before falling
back to the SPA:

```nginx
location / {
    # $uri/  is what finds build/track/index.html for a request to /track.
    # Without it every URL falls straight through to /index.html and the new
    # metadata is never sent.
    try_files $uri $uri/ /index.html;
}
```

Then, as always:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Check it worked — this must print the Somali title, not "TAMS":

```bash
curl -s https://tams.ecosagency.com/track | grep -o '<title>[^<]*</title>'
```

## What you have to do, in Google

Code cannot put you in a search index. Two steps, both free, both about ten
minutes:

1. **Google Search Console** — https://search.google.com/search-console
   Add `tams.ecosagency.com`, verify it (the DNS TXT record is the least
   fragile method), then submit `https://tams.ecosagency.com/sitemap.xml`.
2. **Request indexing** for `https://tams.ecosagency.com/track` from the URL
   Inspection tool. This usually gets the page crawled within a day or two
   rather than whenever Google gets round to it.

## The honest part

Being *in* the index and *ranking* for a phrase are different problems.

Searching "Raadi Alaabtaada" will show results from every Somali site using
those ordinary words, and a brand-new domain does not outrank established ones
by asking. What will realistically work from day one is a search that includes
your name — "Mubah Travel tracking", "mubah raadi alaabta" — because almost
nothing else competes for that.

Ranking for the generic phrase, if it comes, comes from people searching your
name and clicking your result, over months. Nothing in a codebase shortcuts it.

So the reliable route to a customer is still the link, and the link is now
worth sharing:

- Put `tams.ecosagency.com/track` on the cargo receipt, on WhatsApp Business,
  and on your Facebook page.
- Send `tams.ecosagency.com/track/CGO-100001` — it opens straight to that
  parcel, and the preview shows the agency name.

The SEO work makes sure that when someone *does* find the page — searched,
shared, or remembered — it looks like a real service instead of an internal
tool with the wrong name on it.
