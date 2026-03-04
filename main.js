/**
 * TheirStack Company Finder — Apify Actor
 * Uses the official TheirStack API v1
 * Docs: https://api.theirstack.com
 */

import { Actor, log } from 'apify';
import pLimit from 'p-limit';

await Actor.init();

// ─── Country name → ISO2 code ─────────────────────────────────────────────────
const COUNTRY_CODES = {
    'united states': 'US', 'usa': 'US', 'us': 'US',
    'united kingdom': 'GB', 'uk': 'GB', 'gb': 'GB',
    'germany': 'DE', 'france': 'FR', 'canada': 'CA',
    'australia': 'AU', 'netherlands': 'NL', 'india': 'IN',
    'spain': 'ES', 'brazil': 'BR', 'italy': 'IT',
    'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
    'finland': 'FI', 'singapore': 'SG', 'israel': 'IL',
    'ireland': 'IE', 'portugal': 'PT', 'belgium': 'BE',
    'switzerland': 'CH', 'austria': 'AT', 'poland': 'PL',
    'mexico': 'MX', 'argentina': 'AR', 'colombia': 'CO',
    'chile': 'CL', 'japan': 'JP', 'south korea': 'KR',
    'china': 'CN', 'new zealand': 'NZ', 'south africa': 'ZA',
    'uae': 'AE', 'united arab emirates': 'AE',
};

function countryToCode(name) {
    if (!name || name.trim() === '') return null;
    const key = name.toLowerCase().trim();
    const code = COUNTRY_CODES[key] ?? key.toUpperCase();
    if (code.length !== 2) {
        log.warning(`Could not resolve country "${name}" to ISO2 code — skipping country filter`);
        return null;
    }
    return code;
}

// ─── Parse employee size range ────────────────────────────────────────────────
function parseEmployeeRange(sizeStr) {
    if (!sizeStr) return { min: null, max: null };
    if (sizeStr.endsWith('+')) {
        return { min: parseInt(sizeStr), max: null };
    }
    const parts = sizeStr.split('-').map(s => parseInt(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return { min: parts[0], max: parts[1] };
    }
    return { min: null, max: null };
}

// ─── Input ────────────────────────────────────────────────────────────────────
const input = await Actor.getInput();
log.info('Raw input: ' + JSON.stringify(input));

const {
    technology: technologyRaw,
    customTechnology,
    country: countryRaw,
    customCountry,
    industry: industryRaw,
    customIndustry,
    companySize,
    maxResults = 100,
    hunterApiKey = null,
} = input ?? {};

const technology = (technologyRaw === 'Other' ? customTechnology : technologyRaw)?.trim();
const country    = (countryRaw    === 'Other' ? customCountry    : countryRaw)?.trim();
const industry   = (industryRaw   === 'Other' ? customIndustry   : industryRaw)?.trim();

if (!technology) {
    log.error('"technology" input is required.');
    await Actor.exit({ exitCode: 1 });
}

const technologySlug = technology.toLowerCase().replace(/\s+/g, '-');
const countryCode    = countryToCode(country);
const { min: minEmployees, max: maxEmployees } = parseEmployeeRange(companySize);

const THEIRSTACK_API_KEY = process.env.THEIRSTACK_API_KEY;
if (!THEIRSTACK_API_KEY) {
    log.error('THEIRSTACK_API_KEY environment variable is not set. Add it in Actor → Settings → Environment Variables.');
    await Actor.exit({ exitCode: 1 });
}

log.info(
    `Starting — Technology: ${technology} (slug: ${technologySlug})` +
    ` | Country: ${country || 'any'} (${countryCode || 'no filter'})` +
    ` | Industry: ${industry || 'any'} (client-side filter)` +
    ` | Employees: ${companySize || 'any'} (min=${minEmployees}, max=${maxEmployees})` +
    ` | Max results: ${maxResults}`
);

// ─── TheirStack API call ──────────────────────────────────────────────────────
async function searchCompanies({ technologySlug, countryCode, minEmployees, maxEmployees, page, limit }) {
    // Only include fields defined in CompanySearchFilters (additionalProperties: false)
    const body = {
        company_technology_slug_or: [technologySlug],
        page,
        limit,
        include_total_results: false,
        order_by: [{ field: 'employee_count', desc: true }],
    };

    if (countryCode)    body.company_country_code_or = [countryCode];
    if (minEmployees)   body.min_employee_count = minEmployees;
    if (maxEmployees)   body.max_employee_count = maxEmployees;

    log.info(`Page ${page} request body: ${JSON.stringify(body)}`);

    const res = await fetch('https://api.theirstack.com/v1/companies/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${THEIRSTACK_API_KEY}`,
        },
        body: JSON.stringify(body),
    });

    if (res.status === 429) {
        log.warning('Rate limited (429) — waiting 15s...');
        await new Promise(r => setTimeout(r, 15_000));
        return searchCompanies({ technologySlug, countryCode, minEmployees, maxEmployees, page, limit });
    }

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`TheirStack API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    // Response shape: { metadata: {...}, data: [...] }
    return Array.isArray(json?.data) ? json.data : [];
}

// ─── Client-side industry filter ──────────────────────────────────────────────
function matchesIndustry(company) {
    if (!industry) return true;
    const ind = (company.industry ?? '').toLowerCase();
    return ind.includes(industry.toLowerCase());
}

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
    } catch (err) {
        log.warning(`Hunter.io failed for ${domain}: ${err.message}`);
        return {};
    }
}

// ─── Main loop ────────────────────────────────────────────────────────────────
const limiter   = pLimit(3);
const collected = [];
let   page      = 0;
const PAGE_SIZE = Math.min(maxResults, 25); // Free tier max is 25/page; paid tier allows 100

while (collected.length < maxResults) {
    log.info(`Fetching page ${page}...`);

    const companies = await searchCompanies({
        technologySlug, countryCode, minEmployees, maxEmployees,
        page, limit: PAGE_SIZE,
    });

    if (!companies.length) {
        log.info('No more results from API.');
        break;
    }

    const filtered = companies.filter(matchesIndustry);
    log.info(`Page ${page}: ${companies.length} from API → ${filtered.length} after industry filter`);

    const enriched = await Promise.all(
        filtered.slice(0, maxResults - collected.length).map(company =>
            limiter(async () => {
                const domain     = company.domain ?? null;
                const hunterData = await enrichWithHunter(domain);
                return {
                    name:             company.name          ?? null,
                    domain,
                    website:          company.url           ?? domain,
                    linkedin:         company.linkedin_url  ?? null,
                    country:          company.country       ?? null,
                    countryCode:      company.country_code  ?? null,
                    industry:         company.industry      ?? null,
                    employees:        company.employee_count        ?? null,
                    employeeRange:    company.employee_count_range  ?? null,
                    foundedYear:      company.founded_year  ?? null,
                    technology,
                    scrapedAt:        new Date().toISOString(),
                    ...hunterData,
                };
            })
        )
    );

    for (const record of enriched) {
        if (collected.length >= maxResults) break;
        collected.push(record);
        await Actor.pushData(record);
    }

    log.info(`Progress: ${collected.length} / ${maxResults} collected`);

    if (companies.length < PAGE_SIZE) {
        log.info('Last page reached.');
        break;
    }
    page++;
}

log.info(`✅ Done. Saved ${collected.length} companies to dataset.`);
await Actor.exit();
