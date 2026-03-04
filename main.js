/**
 * TheirStack Company Finder — Apify Actor
 * Scrapes public TheirStack technology pages (no API key or credits required)
 * URL pattern: https://theirstack.com/en/technology/{slug}/{country?}
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// ─── Country name → ISO2 ────────────────────────────────────────────────────
const COUNTRY_CODES = {
    'united states': 'us', 'usa': 'us',
    'united kingdom': 'gb', 'uk': 'gb',
    'germany': 'de', 'france': 'fr', 'canada': 'ca',
    'australia': 'au', 'netherlands': 'nl', 'india': 'in',
    'spain': 'es', 'brazil': 'br', 'italy': 'it',
    'sweden': 'se', 'norway': 'no', 'denmark': 'dk',
    'singapore': 'sg', 'israel': 'il', 'ireland': 'ie',
    'portugal': 'pt', 'belgium': 'be', 'switzerland': 'ch',
    'poland': 'pl', 'mexico': 'mx', 'japan': 'jp',
};

const INDUSTRY_ALIASES = {
    'edtech':     ['education', 'e-learning', 'elearning', 'edtech'],
    'saas':       ['software', 'saas', 'internet'],
    'fintech':    ['financial', 'fintech', 'banking', 'insurance'],
    'healthtech': ['health', 'medical', 'hospital', 'wellness'],
    'martech':    ['marketing', 'advertising'],
};

function matchesIndustry(text, filter) {
    if (!filter) return true;
    const t = (text ?? '').toLowerCase();
    const s = filter.toLowerCase();
    if (t.includes(s)) return true;
    return (INDUSTRY_ALIASES[s] ?? []).some(a => t.includes(a));
}

function parseEmployeeCount(empText) {
    if (!empText) return null;
    const t = empText.trim().replace(/,/g, '');
    const m = t.match(/^([\d.]+)\s*([kKmMbB])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const suffix = (m[2] ?? '').toLowerCase();
    if (suffix === 'k') n *= 1_000;
    else if (suffix === 'm') n *= 1_000_000;
    else if (suffix === 'b') n *= 1_000_000_000;
    return Math.round(n);
}

function matchesSize(empText, sizeStr) {
    if (!sizeStr) return true;
    const n = parseEmployeeCount(empText);
    if (n == null) return true;  // can't parse = don't exclude
    if (sizeStr.endsWith('+')) return n >= parseInt(sizeStr);
    const [mn, mx] = sizeStr.split('-').map(Number);
    return n >= mn && n <= mx;
}

// ─── Input ──────────────────────────────────────────────────────────────────
const input = await Actor.getInput();
const {
    technology: techRaw,
    customTechnology,
    country: countryRaw,
    customCountry,
    industry,
    companySize,
    maxResults = 50,
    hunterApiKey = null,
    debugHtml = false,   // set true in input to dump raw HTML
} = input ?? {};

const technology = (techRaw === 'Other' ? customTechnology : techRaw)?.trim();
const country    = (countryRaw === 'Other' ? customCountry : countryRaw)?.trim();

if (!technology) {
    log.error('"technology" is required.');
    await Actor.exit({ exitCode: 1 });
}

const techSlug    = technology.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const countrySlug = country
    ? (COUNTRY_CODES[country.toLowerCase()] ?? country.toLowerCase())
    : null;

const baseUrl = countrySlug
    ? `https://theirstack.com/en/technology/${techSlug}/${countrySlug}`
    : `https://theirstack.com/en/technology/${techSlug}`;

log.info(`Target URL: ${baseUrl}`);
log.info(`Filters — Industry: ${industry || 'any'} | Size: ${companySize || 'any'} | Max: ${maxResults}`);

// ─── Hunter.io ──────────────────────────────────────────────────────────────
async function enrichWithHunter(domain) {
    if (!hunterApiKey || !domain) return {};
    try {
        const res = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterApiKey}&limit=5`);
        if (!res.ok) return {};
        const { data = {} } = await res.json();
        return {
            emails:        (data.emails ?? []).map(e => e.value).slice(0, 5),
            emailPattern:  data.pattern ?? null,
            contactsFound: data.emails?.length ?? 0,
        };
    } catch { return {}; }
}

// ─── State ──────────────────────────────────────────────────────────────────
const collected = [];
let   stopped   = false;

// ─── Crawler ─────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
    },
    maxConcurrency: 1,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 45,

    async requestHandler({ page, request, enqueueLinks }) {
        if (stopped) return;
        log.info(`Loading: ${request.url}`);

        // Just wait for the network to settle — no specific selector
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {
            log.warning('networkidle timed out — continuing anyway');
        });

        // Extra wait for JS frameworks to render
        await page.waitForTimeout(3000);

        // ── DEBUG: dump HTML so we can see the structure ─────────────────────
        if (debugHtml || collected.length === 0) {
            const html = await page.evaluate(() => document.body.innerHTML);
            const text = await page.evaluate(() => document.body.innerText);
            log.info('=== PAGE TEXT (first 3000 chars) ===\n' + text.slice(0, 3000));
            log.info('=== PAGE HTML (first 3000 chars) ===\n' + html.slice(0, 3000));
        }

        // ── Extract: company rows have exactly 6 cells ────────────────────────
        // (Country stats rows at bottom only have 2 cells — skip those)
        const companies = await page.evaluate(() => {
            const results = [];

            const rows = document.querySelectorAll('table tbody tr');
            rows.forEach(row => {
                const tds = Array.from(row.querySelectorAll('td'));
                if (tds.length !== 6) return; // skip non-company rows

                const getText = i => tds[i]?.innerText?.trim().split('\n')[0].trim() || null;

                // LinkedIn URL from company cell
                const linkedinLink = tds[0].querySelector('a[href*="linkedin.com"]');
                // TheirStack company slug from any /company/ link
                const tsLink = Array.from(tds[0].querySelectorAll('a[href*="/company/"]'))[0];
                const slug = tsLink?.href?.match(/\/company\/([^/?#]+)/)?.[1] ?? null;

                results.push({
                    name:      getText(0),
                    domain:    slug,          // e.g. "capgemini" — best we can get without login
                    country:   getText(1),
                    industry:  getText(2),
                    employees: getText(3),    // e.g. "420k"
                    revenue:   getText(4),
                    linkedin:  linkedinLink?.href ?? null,
                    _strategy: 'table-6col',
                });
            });

            if (results.length > 0) return results;
            return [{ _debug: true, text: document.body.innerText.slice(0, 500) }];
        });

        log.info(`Strategy: ${companies[0]?._strategy ?? 'debug'} | Found: ${companies.filter(c => !c._debug).length} rows`);

        if (companies[0]?._debug) {
            log.warning('Could not parse companies. Dumping page text above — share with developer to fix selectors.');
            return;
        }

        // ── Filter & save ────────────────────────────────────────────────────
        for (const c of companies) {
            if (stopped || collected.length >= maxResults) { stopped = true; break; }
            if (!matchesIndustry(c.industry, industry)) continue;
            if (!matchesSize(c.employees?.replace(/[^0-9kKmMbB.]/g, ''), companySize)) continue;

            const enrichment = await enrichWithHunter(c.domain);
            const record = {
                name:      c.name,
                domain:    c.domain,
                linkedin:  c.linkedin,
                country:   c.country,
                industry:  c.industry,
                employees: c.employees,
                technology,
                sourceUrl: request.url,
                scrapedAt: new Date().toISOString(),
                ...enrichment,
            };
            collected.push(record);
            await Actor.pushData(record);
            log.info(`[${collected.length}/${maxResults}] ${record.name}`);
        }

        if (stopped || collected.length >= maxResults) { stopped = true; return; }

        // ── Pagination: always construct ?page=N ────────────────────────────
        // The "Go to next page" button links to app.theirstack.com (requires login).
        // The public site paginates via ?page=2, ?page=3 etc.
        const validCompanies = companies.filter(c => !c._debug);
        if (validCompanies.length >= 10) {
            const url = new URL(request.url);
            const cur = parseInt(url.searchParams.get('page') ?? '1');
            url.searchParams.set('page', cur + 1);
            log.info(`Enqueuing page ${cur + 1}: ${url}`);
            await enqueueLinks({ urls: [url.toString()] });
        } else {
            log.info('Last page reached.');
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed ${request.url}: ${error.message}`);
    },
});

await crawler.run([baseUrl]);
log.info(`✅ Done. ${collected.length} companies saved.`);
await Actor.exit();
