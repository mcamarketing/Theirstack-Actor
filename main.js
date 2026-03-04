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

function matchesSize(empText, sizeStr) {
    if (!sizeStr || !empText) return true;
    const n = parseInt((empText ?? '').replace(/[^0-9]/g, ''));
    if (isNaN(n)) return true;
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

        // ── Extract: try multiple selector strategies ────────────────────────
        const companies = await page.evaluate(() => {
            const results = [];

            // Strategy 1: <table> rows
            const rows = document.querySelectorAll('table tbody tr');
            if (rows.length > 0) {
                rows.forEach(row => {
                    const tds   = Array.from(row.querySelectorAll('td'));
                    const texts = tds.map(td => td.innerText.trim());
                    const link  = row.querySelector('a[href]');
                    const href  = link?.href ?? '';
                    results.push({
                        name:      texts[0] || null,
                        domain:    href.includes('://') ? new URL(href).hostname.replace('www.','') : null,
                        country:   texts[1] || null,
                        industry:  texts[2] || null,
                        employees: texts[3] || null,
                        linkedin:  null,
                        _strategy: 'table',
                    });
                });
                return results;
            }

            // Strategy 2: any <a> tag containing a company domain inside a list/grid
            // Look for elements with a pattern of repeated structure
            const allLinks = Array.from(document.querySelectorAll('a[href]'));
            const companyLinks = allLinks.filter(a => {
                const href = a.href;
                return href.includes('/company/') || href.includes('linkedin.com/company');
            });

            if (companyLinks.length > 0) {
                companyLinks.forEach(link => {
                    const parent = link.closest('li, tr, div[class], article') ?? link.parentElement;
                    const text   = parent?.innerText?.trim() ?? '';
                    results.push({
                        name:      link.innerText.trim() || text.split('\n')[0] || null,
                        domain:    null,
                        country:   null,
                        industry:  null,
                        employees: null,
                        linkedin:  link.href.includes('linkedin') ? link.href : null,
                        _strategy: 'company-link',
                    });
                });
                return results;
            }

            // Strategy 3: dump all visible text blocks for manual inspection
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
            if (!matchesSize(c.employees, companySize)) continue;

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

        // ── Pagination: find next page link ──────────────────────────────────
        const nextHref = await page.evaluate(() => {
            // rel="next" is the cleanest signal
            const rel = document.querySelector('a[rel="next"]');
            if (rel) return rel.href;

            // aria-label="next page" / "next"
            const aria = Array.from(document.querySelectorAll('a')).find(a =>
                /next/i.test(a.getAttribute('aria-label') ?? '') ||
                /next/i.test(a.innerText)
            );
            if (aria) return aria.href;

            return null;
        });

        if (nextHref && nextHref !== request.url) {
            log.info(`Next page: ${nextHref}`);
            await enqueueLinks({ urls: [nextHref] });
        } else {
            // Fallback: bump ?page= param
            const url = new URL(request.url);
            const cur = parseInt(url.searchParams.get('page') ?? '1');
            if (companies.length >= 8) {   // assume full page = more pages exist
                url.searchParams.set('page', cur + 1);
                log.info(`Constructed next: ${url}`);
                await enqueueLinks({ urls: [url.toString()] });
            } else {
                log.info('Reached last page.');
            }
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed ${request.url}: ${error.message}`);
    },
});

await crawler.run([baseUrl]);
log.info(`✅ Done. ${collected.length} companies saved.`);
await Actor.exit();
