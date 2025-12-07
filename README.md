# Domain Inventory

A small, browser-only web app to help keep track of your domains, where their DNS is hosted, where each host is virtually hosted (GitHub Pages, Cloud Run, etc.), and when the domains expire.

Everything runs entirely in your browser and is stored in `localStorage`. There is **no backend**.

## Features

* Add domains and a list of hosts/subdomains (e.g. `@`, `www`, `mail`).
* Store all data in the browser using `localStorage`.
* Import/export all data as a JSON file.
* Per-domain DNS lookup via DNS-over-HTTPS.
* Per-domain RDAP lookup for registrar and expiry (where supported).
* Automatic detection of **DNS provider** (Gandi / AWS Route 53 / Cloudflare).
* Per-host detection of **virtual hosting provider** using DNS heuristics.
* Expiry date shown in the main table, with colour-coded rows:

  * **Red** – expiry date has passed
  * **Amber** – expiry date within the next month
  * **Green** – expiry date more than a month away
* Click into a domain to see:

  * Summary (registrar, expiry, status)
  * DNS summary (NS, MX, TXT)
  * Per-host records (A/AAAA/CNAME + guessed hosting)
* Edit and delete domains in-place.

## Live site

The tool is available online at [davorg.dev/mydomains](https://davorg.dev/mydomains).

## How it works

The app is a single-page site consisting of:

* `index.html` – main page and structure
* `css/style.css` – styling
* `js/script.js` – logic (state, DNS/RDAP lookups, heuristics)

State is stored in `localStorage` under the key `domainInventory.v1`. Import/export simply serialises/deserialises this state to/from JSON.

### DNS lookups

DNS lookups use **DNS-over-HTTPS** via Google:

* `https://dns.google/resolve?name=<name>&type=<type>`

This is used to fetch:

* `NS` records (for DNS provider detection)
* `MX` records
* `TXT` records
* `A` / `AAAA` / `CNAME` per host

### RDAP lookups

RDAP lookups currently use the **rdap.org** aggregator:

* `https://rdap.org/domain/<domain>`

From the RDAP response we extract:

* Registrar name (from the `registrar` entity)
* Expiry date (from the `expiration` event)
* Status list

The expiry date is used both in the domain detail view and in the main table, where it drives the row colour.

> **Note:** Some TLDs (especially certain ccTLDs like `.de`) either aren’t supported by rdap.org or have RDAP endpoints that do not allow cross-origin requests. In those cases, the app will not show registrar/expiry data.

## Usage

1. Clone the repository:

   ```bash
   git clone <this-repo-url>
   cd <repo>
   ```

2. Open `index.html` in a browser (you can just open it directly from the filesystem; no server needed).

3. Use the **Add Domain** form to add a domain and a comma-separated list of hosts/subdomains (e.g. `@, www, mail`).

4. Click a row in the **Domains** table to open the detail view.

5. Click **"Refresh DNS / RDAP"** to fetch and cache DNS/RDAP information for that domain.

6. Use **Export JSON** to download the current state to a file, and **Import JSON** to load a previously exported file.

7. Use **Edit** and **Delete** buttons in the table to manage domains.

## Heuristics and assumptions

This app is opinionated and currently tuned for a specific personal setup. In particular:

### DNS providers

DNS provider detection is purely based on nameserver hostnames. At the moment it only recognises:

* **Cloudflare** – any NS containing `cloudflare.com`
* **AWS Route 53** – any NS containing `awsdns`
* **Gandi** – any NS containing `gandi.net`

Anything else is shown as **`Unknown`**.

### Virtual hosting providers

"Where is it hosted" is based entirely on DNS records for each host and uses simple heuristics. Right now it can recognise:

* **GitHub Pages**

  * CNAME ends with `.github.io`, or
  * A records in the `185.199.108.0/22` range (GitHub Pages IPs)

* **AWS**

  * **CloudFront**: CNAME ends with `.cloudfront.net`
  * **S3 website hosting**: CNAME contains `.s3.amazonaws.com` or `s3-website-`

* **Google Cloud**

  * **Cloud Run**: CNAME ends with `.a.run.app`
  * **Google-hosted**: CNAME exactly `ghs.googlehosted.com`

* **Gandi web redirection**

  * Any reference to `webredir.gandi.net` in CNAME / A / AAAA chains

* **IONOS VPS**

  * A records matching a small, hard-coded list of known VPS IP addresses

Anything that doesn’t match these patterns is shown as:

* `Unknown`

Additionally, if the IPs resolve to Cloudflare edge addresses (common when a site is proxied through Cloudflare), the app will label the hosting as:

* `Unknown (via Cloudflare)`

This is deliberate: Cloudflare hides the origin server at the DNS level, so the app cannot safely infer the real hosting provider from DNS alone.

### Subdomains / hosts

The app does **not** attempt to discover subdomains. It only works with the list of hosts you provide manually (e.g. `@`, `www`, `mail`, `blog`). For each host it will:

* Construct the FQDN (`@` → `example.com`; `www` → `www.example.com`)
* Look up `A` / `AAAA` / `CNAME`
* Apply the hosting heuristics above

## Limitations

Some important limitations to be aware of:

* **Browser-only & localStorage**

  * All data lives in `localStorage` in one browser profile on one device.
  * There is no sync between devices/browsers except via manual import/export.

* **RDAP coverage**

  * RDAP lookups use `rdap.org` and are subject to whatever that service supports.
  * Some TLDs (e.g. certain ccTLDs like `.de`) may not return data or may be blocked by CORS.
  * Where RDAP fails, registrar and expiry information will be blank, and the row won’t be colour-coded.

* **DNS provider support is narrow**

  * Only Gandi, AWS Route 53 and Cloudflare are recognised as DNS providers.
  * Other DNS providers will simply appear as `Unknown`.

* **Hosting heuristics are narrow and approximate**

  * Designed around a personal stack: GitHub Pages, AWS (CloudFront/S3), Google Cloud Run/Google-hosted, Gandi web redirection, and a handful of IONOS VPS IPs.
  * Many real-world providers (Netlify, Vercel, DigitalOcean, etc.) are not currently recognised.
  * Even for supported providers, detection is based on DNS patterns and may sometimes be wrong.

* **Cloudflare hides the origin**

  * For proxied domains, the app will usually show `Unknown (via Cloudflare)` unless there is an independent signal of the underlying platform.

* **No HTTP probing**

  * The app does not currently make HTTP requests to the sites themselves; it only looks at DNS and RDAP.
  * That keeps it simple but also limits what it can infer.

* **No authentication / multi-user support**

  * This is a personal tool, not a multi-user service.

## Roadmap / ideas

A few possible future enhancements (no promises):

* Optional small proxy service to:

  * Provide RDAP data for TLDs that don’t support browser-based requests.
  * Optionally do lightweight HTTP probing (follow redirects, inspect headers) for better hosting detection.
* More pluggable provider detection (easier to add/remove heuristics via config).
* Per-host manual overrides for hosting provider.
* Simple health checks (e.g. flag hosts with no A/AAAA/CNAME or missing MX/SPF/DMARC).

## License

This project is licensed under the MIT License. See `LICENSE` for details.

