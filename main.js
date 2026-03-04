/**
 * TheirStack Company Finder — Apify Actor
 * Scrapes public TheirStack technology pages (no API key or credits required)
 * URL pattern: https://theirstack.com/en/technology/{slug}/{country?}?page={n}
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// ─── Country name → ISO2 code (lowercase for URL) ────────────────────────────
const COUNTRY_CODES = {
    'united states': 'us', 'usa': 'us',
    'united kingdom': 'gb', 'uk': 'gb',
    'germany': 'de', 'france': 'fr', 'canada': 'ca',
    'australia': 'au', 'netherlands': 'nl', 'india': 'in',
    'spain': 'es', 'brazil': 'br', 'italy': 'it',
    'sweden': 'se', 'norway': 'no', 'denmark': 'dk',
    'finland': 'fi', 'singapore': 'sg', 'israel': 'il',
    'ireland': 'ie', 'portugal': 'pt', 'belgium': 'be',
    'switzerland': 'ch', 'austria': 'at', 'poland': 'pl',
    'mexico': 'mx', 'argentina': 'ar', 'colombia': 'co',
    'chile': 'cl', 'japan': 'jp', 'south korea': 'kr',
    'china': 'cn', 'new zealand': 'nz', 'south africa': 'za',
    'uae': 'ae', 'united arab emirates': 'ae',
};

// ─── Industry alias matching ──────────────────────────────────────────────────
const INDUSTRY_ALIASES = {
    'edtech':     ['education', 'e-learning', 'elearning', 'edtech'],
    'saas':       ['software', 'saas', 'internet'],
    'fintech':    ['financial', 'fintech', 'banking', 'insurance'],
    'healthtech': ['health', 'medical', 'hospital', 'wellness'],
    'martech':    ['marketing', 'advertising'],
    'hrtech':     ['human resources', 'staffing', 'recruiting'],
    'legaltech':  ['legal', 'law'],
    'proptech':   ['real estate'],
    'cleantech':  ['renewable', 'energy', 'environmental'],
    'logistics':  ['logistics', 'transportation', 'supply chain'],
};

function matchesIndustry(industryText, filter) {
    if (!filter) return true;
    const ind = (industryText ?? '').toLowerCase();
    const search = filter.toLowerCase();
    if (ind.includes(search)) return true;
    const aliases = INDUSTRY_ALIASES[search];
    if (aliases) return aliases.some(a => ind.includes(a));
    return false;
}

function matchesSize(employeeCount, sizeStr) {
    if (!sizeStr || employeeCount == null) return true;
    const count = parseInt(employeeCount);
    if (isNaN(count)) return true;
    if (sizeStr.endsWith('+')) return count >= parseInt(sizeStr);
    const [min, max] = sizeStr.split('-').map(Number);
    return count >= min && count <= max;
}

// ─── Input ────────────────────────────────────────────────────────────────────
const input = await Actor.getInput();
log.info('Input: ' + JSON.stringify(input));

const {
    technology: technologyRaw,
    customTechnology,
    country: countryRaw,
    customCountry,
    industry,
    companySize,
    maxResults = 100,
    hunterApiKey = null,
} = input ?? {};

const technology = (technologyRaw === 'Other' ? customTechnology : technologyRaw)?.trim();
const country    = (countryRaw    === 'Other' ? customCountry    : countryRaw)?.trim();

if (!technology) {
    log.error('"technology" input is required.');
    await Actor.exit({ exitCode: 1 });
}

const techSlug    = technology.toLowerCase().replace(/\s+/g, '-');
const countryCode = country ? (COUNTRY_CODES[country.toLowerCase()] ?? country.toLowerCase()) : null;

// Build start URL: https://theirstack.com/en/technology/react/us
const baseUrl = countryCode
    ? `https://theirstack.com/en/technology/${techSlug}/${countryCode}`
    : `https://theirstack.com/en/technology/${techSlug}`;

log.info(`Scraping: ${baseUrl} | Industry: ${industry || 'any'} | Size: ${companySize || 'any'} | Max: ${maxResults}`);

// ─── State ────────────────────────────────────────────────────────────────────
const collected = [];
let   done      = false;

// ─── Hunter.io enrichment ─────────────────────────────────────────────────────
async function enrichWithHunter(domain) {
    if (!hunterApiKey || !domain) return {};
    try {
        const res = await fetch(
            `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterApiKey}&limit=5`
        );
        if (!res.ok) return {};
        const json = await res.json();
        const data = json?.data ?? {};
        return {
            emails:        (data.emails ?? []).map(e => e.value).slice(0, 5),
            emailPattern:  data.pattern ?? null,
            contactsFound: data.emails?.length ?? 0,
        };
    } catch {
        return {};
    }
}

// ─── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    },
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 60,

    async requestHandler({ page, request, enqueueLinks }) {
        if (done) return;

        log.info(`Scraping: ${request.url}`);

        // Wait for company rows to load
        await page.waitForSelector('table tbody tr, [data-testid="company-row"], .company-row', {
            timeout: 15000,
        }).catch(() => {
            log.warning('No company table found — trying generic row selector');
        });

        // Give JS a moment to hydrate
        await page.waitForTimeout(2000);

        // Extract company data from the page
        // TheirStack renders a table with company info
        const companies = await page.evaluate(() => {
            const rows = [];

            // Try table rows first
            const tableRows = document.querySelectorAll('table tbody tr');
            if (tableRows.length > 0) {
                tableRows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 2) return;

                    // Extract text from each cell
                    const texts = Array.from(cells).map(c => c.innerText.trim());
                    const links = Array.from(row.querySelectorAll('a'));
                    const companyLink = links.find(a => a.href && a.href.includes('/company/'));

                    rows.push({
                        name:      cells[0]?.innerText?.trim() ?? null,
                        domain:    companyLink?.href?.split('/company/')?.[1]?.split('?')[0] ?? null,
                        country:   texts[1] ?? null,
                        industry:  texts[2] ?? null,
                        employees: texts[3] ?? null,
                        rawCells:  texts,
                    });
                });
                return rows;
            }

            // Fallback: look for any repeated card-like structure
            const cards = document.querySelectorAll('[class*="company"], [class*="Company"]');
            cards.forEach(card => {
                const nameEl = card.querySelector('h2, h3, [class*="name"], [class*="Name"]');
                const domainEl = card.querySelector('a[href*="http"]');
                rows.push({
                    name:      nameEl?.innerText?.trim() ?? null,
                    domain:    domainEl?.href ?? null,
                    country:   null,
                    industry:  null,
                    employees: null,
                });
            });

            return rows;
        });

        log.info(`Found ${companies.length} companies on page`);

        // If we got nothing, dump the page HTML for debugging
        if (companies.length === 0) {
            const snippet = await page.evaluate(() => document.body.innerText.slice(0, 2000));
            log.warning('No companies parsed. Page text snippet:\n' + snippet);
        }

        // Filter and collect
        for (const company of companies) {
            if (done || collected.length >= maxResults) { done = true; break; }

            if (!matchesIndustry(company.industry, industry)) continue;
            if (!matchesSize(company.employees?.replace(/[^0-9]/g, ''), companySize)) continue;

            const hunterData = await enrichWithHunter(company.domain);
            const record = {
                name:        company.name,
                domain:      company.domain,
                country:     company.country,
                industry:    company.industry,
                employees:   company.employees,
                technology,
                scrapedAt:   new Date().toISOString(),
                sourceUrl:   request.url,
                ...hunterData,
            };

            collected.push(record);
            await Actor.pushData(record);
            log.info(`[${collected.length}/${maxResults}] ${record.name} — ${record.industry} — ${record.employees}`);
        }

        if (done || collected.length >= maxResults) {
            done = true;
            return;
        }

        // Find and enqueue the "next page" link
        const nextUrl = await page.evaluate(() => {
            // Look for pagination: ?page=N pattern or a "next" button
            const links = Array.from(document.querySelectorAll('a[href]'));
            const nextLink = links.find(a =>
                a.getAttribute('aria-label')?.toLowerCase().includes('next') ||
                a.innerText?.toLowerCase().trim() === 'next' ||
                a.innerText?.includes('→') ||
                a.querySelector('[aria-label*="next"]')
            );
            return nextLink?.href ?? null;
        });

        if (nextUrl && nextUrl !== request.url) {
            log.info(`Next page: ${nextUrl}`);
            await enqueueLinks({ urls: [nextUrl] });
        } else {
            // Try constructing next page URL manually (?page=N)
            const url = new URL(request.url);
            const currentPage = parseInt(url.searchParams.get('page') || '1');
            const nextPage = currentPage + 1;
            url.searchParams.set('page', nextPage);
            const constructedNext = url.toString();

            // Only enqueue if we got a full page (10 results = more pages likely)
            if (companies.length >= 10) {
                log.info(`Trying constructed next page: ${constructedNext}`);
                await enqueueLinks({ urls: [constructedNext] });
            } else {
                log.info('Last page reached (fewer than 10 results).');
            }
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} — ${error.message}`);
    },
});

await crawler.run([baseUrl]);

log.info(`✅ Done. Saved ${collected.length} companies.`);
await Actor.exit();
