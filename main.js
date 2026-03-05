/**
 * TheirStack Company Finder — Apify Actor
 * Uses a logged-in session cookie to access server-side filtered search.
 * No API credits consumed — intercepts the internal API calls the app makes.
 *
 * How to get your session cookie:
 * 1. Log into app.theirstack.com in Chrome
 * 2. Open DevTools → Application → Cookies → https://app.theirstack.com
 * 3. Copy the value of the cookie named "__session" (or whichever is longest)
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

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
    const t = String(empText).replace(/,/g, '').trim();
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
    if (n == null) return true;
    if (sizeStr.endsWith('+')) return n >= parseInt(sizeStr);
    const [mn, mx] = sizeStr.split('-').map(Number);
    return n >= mn && n <= mx;
}

function matchesCountry(companyCountry, filter) {
    if (!filter) return true;
    if (!companyCountry) return false;
    return companyCountry.toLowerCase().includes(filter.toLowerCase());
}

// ─── Country name → ISO2 ─────────────────────────────────────────────────────
const COUNTRY_CODES = {
    'united states': 'US', 'usa': 'US', 'us': 'US',
    'united kingdom': 'GB', 'uk': 'GB',
    'germany': 'DE', 'france': 'FR', 'canada': 'CA',
    'australia': 'AU', 'netherlands': 'NL', 'india': 'IN',
    'spain': 'ES', 'brazil': 'BR', 'italy': 'IT',
    'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
    'singapore': 'SG', 'israel': 'IL', 'ireland': 'IE',
    'portugal': 'PT', 'belgium': 'BE', 'switzerland': 'CH',
    'poland': 'PL', 'mexico': 'MX', 'japan': 'JP',
    'south korea': 'KR', 'new zealand': 'NZ', 'south africa': 'ZA',
    'uae': 'AE', 'united arab emirates': 'AE',
};

// ─── Input ────────────────────────────────────────────────────────────────────
const input = await Actor.getInput();
log.info('Input: ' + JSON.stringify({ ...input, sessionCookie: input?.sessionCookie ? '[REDACTED]' : undefined }));

const {
    technology: techRaw,
    customTechnology,
    country: countryRaw,
    customCountry,
    industry,
    companySize,
    maxResults = 100,
    sessionCookie,      // __session cookie value from browser devtools
    hunterApiKey = null,
} = input ?? {};

const technology = (techRaw === 'Other' ? customTechnology : techRaw)?.trim();
const country    = (countryRaw === 'Other' ? customCountry : countryRaw)?.trim();

if (!technology) {
    log.error('"technology" input is required.');
    await Actor.exit({ exitCode: 1 });
}
if (!sessionCookie) {
    log.error('"sessionCookie" input is required. See actor description for how to get it.');
    await Actor.exit({ exitCode: 1 });
}

const techSlug   = technology.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const countryCode = country
    ? (COUNTRY_CODES[country.toLowerCase()] ?? country.toUpperCase().slice(0, 2))
    : null;

log.info(`Technology: ${technology} | Country: ${country || 'any'} (${countryCode || 'no filter'}) | Industry: ${industry || 'any'} | Size: ${companySize || 'any'} | Max: ${maxResults}`);

// ─── Hunter.io enrichment ─────────────────────────────────────────────────────
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

// ─── State ────────────────────────────────────────────────────────────────────
const collected = [];
let   stopped   = false;

// ─── Build the API request body (same as the API, but called via browser session) ──
function buildRequestBody(page) {
    const body = {
        company_technology_slug_or: [techSlug],
        page,
        limit: 100,
        include_total_results: false,
        order_by: [{ field: 'employee_count', desc: false }],
    };
    if (countryCode) body.company_country_code_or = [countryCode];
    return body;
}

// ─── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
    },
    maxConcurrency: 1,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 120,

    async requestHandler({ page, request }) {
        if (stopped) return;

        const pageNum = request.userData.pageNum ?? 0;
        log.info(`Processing page ${pageNum}...`);

        // Set the session cookie before any navigation
        await page.context().addCookies([{
            name:   '__session',
            value:  sessionCookie,
            domain: '.theirstack.com',
            path:   '/',
        }]);

        // Intercept the API response — TheirStack app calls api.theirstack.com internally
        let apiData = null;

        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('api.theirstack.com/v1/companies/search') ||
                url.includes('theirstack.com/v1/companies/search')) {
                try {
                    const json = await response.json();
                    if (json?.data) {
                        apiData = json.data;
                        log.info(`Intercepted API response: ${apiData.length} companies`);
                    }
                } catch { /* response may already be consumed */ }
            }
        });

        // Navigate to the app — this triggers the internal API call
        // Use the search URL with our technology filter
        const searchUrl = `https://app.theirstack.com/en/technology/${techSlug}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 25000 })
            .catch(() => log.warning('networkidle timeout — continuing'));

        await page.waitForTimeout(3000);

        // If interception didn't work, fall back to calling the API directly using
        // the session cookie as the auth credential
        if (!apiData) {
            log.info('Interception got nothing — calling API directly with session cookie...');

            apiData = await page.evaluate(async ({ body, cookie }) => {
                try {
                    const res = await fetch('https://api.theirstack.com/v1/companies/search', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Cookie': `__session=${cookie}`,
                        },
                        credentials: 'include',
                        body: JSON.stringify(body),
                    });
                    if (!res.ok) {
                        const err = await res.text();
                        return { error: `${res.status}: ${err}` };
                    }
                    const json = await res.json();
                    return json.data ?? [];
                } catch (e) {
                    return { error: e.message };
                }
            }, { body: buildRequestBody(pageNum), cookie: sessionCookie });

            if (apiData?.error) {
                log.error(`API call failed: ${apiData.error}`);
                // Try with Authorization header using cookie value as token
                apiData = await page.evaluate(async ({ body, cookie }) => {
                    try {
                        const res = await fetch('https://api.theirstack.com/v1/companies/search', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${cookie}`,
                            },
                            body: JSON.stringify(body),
                        });
                        if (!res.ok) {
                            const err = await res.text();
                            return { error: `${res.status}: ${err}` };
                        }
                        const json = await res.json();
                        return json.data ?? [];
                    } catch (e) {
                        return { error: e.message };
                    }
                }, { body: buildRequestBody(pageNum), cookie: sessionCookie });

                if (apiData?.error) {
                    log.error(`All auth methods failed: ${apiData.error}`);
                    log.error('Check that your sessionCookie is valid and not expired.');
                    stopped = true;
                    return;
                }
            }
        }

        if (!Array.isArray(apiData) || apiData.length === 0) {
            log.info('No more results.');
            stopped = true;
            return;
        }

        log.info(`Got ${apiData.length} companies from API`);

        // Filter and save
        for (const company of apiData) {
            if (stopped || collected.length >= maxResults) { stopped = true; break; }

            const empCount  = company.employee_count ?? company.employee_count_range ?? null;
            const compCountry = company.country ?? null;
            const compIndustry = company.industry ?? null;

            if (!matchesIndustry(compIndustry, industry)) continue;
            if (!matchesCountry(compCountry, country)) continue;
            if (!matchesSize(String(empCount ?? ''), companySize)) continue;

            const domain = company.domain ?? null;
            const enrichment = await enrichWithHunter(domain);

            const record = {
                name:          company.name          ?? null,
                domain,
                website:       company.url           ?? domain,
                linkedin:      company.linkedin_url  ?? null,
                country:       compCountry,
                countryCode:   company.country_code  ?? null,
                industry:      compIndustry,
                employees:     company.employee_count        ?? null,
                employeeRange: company.employee_count_range  ?? null,
                revenue:       company.annual_revenue_usd    ?? null,
                foundedYear:   company.founded_year  ?? null,
                technology,
                sourceUrl:     request.url,
                scrapedAt:     new Date().toISOString(),
                ...enrichment,
            };

            collected.push(record);
            await Actor.pushData(record);
            log.info(`[${collected.length}/${maxResults}] ${record.name} — ${record.industry} — ${record.employees} employees — ${record.country}`);
        }

        // Enqueue next page if we need more
        if (!stopped && collected.length < maxResults && apiData.length >= 100) {
            await Actor.addRequests([{
                url: `https://app.theirstack.com/en/technology/${techSlug}?page=${pageNum + 1}`,
                userData: { pageNum: pageNum + 1 },
            }]);
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed ${request.url}: ${error.message}`);
    },
});

await crawler.run([{
    url: `https://app.theirstack.com/en/technology/${techSlug}`,
    userData: { pageNum: 0 },
}]);

log.info(`✅ Done. ${collected.length} companies saved.`);
await Actor.exit();
