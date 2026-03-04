/**
 * TheirStack Company Scraper — API Build
 * Apify Actor | TheirStack API + Optional Hunter.io Enrichment
 */

import { Actor, log } from 'apify';
import pLimit from 'p-limit';

await Actor.init();

// ─── Country name → ISO code map ─────────────────────────────────────────────

const COUNTRY_CODES = {
    'united states': 'US', 'united kingdom': 'GB', 'germany': 'DE',
    'france': 'FR', 'canada': 'CA', 'australia': 'AU', 'netherlands': 'NL',
    'india': 'IN', 'spain': 'ES', 'brazil': 'BR', 'italy': 'IT',
    'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
    'singapore': 'SG', 'israel': 'IL', 'ireland': 'IE', 'portugal': 'PT',
    'belgium': 'BE', 'switzerland': 'CH', 'austria': 'AT', 'poland': 'PL',
    'mexico': 'MX', 'argentina': 'AR', 'colombia': 'CO', 'chile': 'CL',
    'japan': 'JP', 'south korea': 'KR', 'china': 'CN', 'new zealand': 'NZ',
};

function countryToCode(name) {
    if (!name) return null;
    const code = COUNTRY_CODES[name.toLowerCase().trim()];
    if (!code) log.warning(`Unknown country "${name}" — skipping country filter. Add it to the COUNTRY_CODES map.`);
    return code ?? null;
}

// ─── Input ────────────────────────────────────────────────────────────────────

const input = await Actor.getInput();
log.info('Raw input received: ' + JSON.stringify(input));

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

const technology = technologyRaw === 'Other' ? customTechnology : technologyRaw;
const country    = countryRaw    === 'Other' ? customCountry    : countryRaw;
const industry   = industryRaw   === 'Other' ? customIndustry   : industryRaw;

if (!technology || technology.trim() === '') {
    log.error('"technology" is required.');
    await Actor.exit({ exitCode: 1 });
}

const technologySlug = technology.trim().toLowerCase().replace(/\s+/g, '-');
const countryCode = countryToCode(country);

// ─── TheirStack API Key ───────────────────────────────────────────────────────

const THEIRSTACK_API_KEY = process.env.THEIRSTACK_API_KEY;
if (!THEIRSTACK_API_KEY) {
    log.error('THEIRSTACK_API_KEY environment variable is not set.');
    await Actor.exit({ exitCode: 1 });
}

log.info(`Starting — Technology: ${technology} (slug: ${technologySlug}) | Country: ${country ?? 'any'} (${countryCode ?? 'no code'}) | Industry: ${industry ?? 'any'} | Size: ${companySize ?? 'any'} | Max: ${maxResults}`);

// ─── Hunter.io enrichment ─────────────────────────────────────────────────────

async function enrichWithHunter(domain) {
    if (!hunterApiKey || !domain) return {};
    try {
        const res = await fetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterApiKey}&limit=5`);
        if (!res.ok) return {};
        const json = await res.json();
        const data = json?.data ?? {};
        return {
            emails: (data.emails ?? []).map(e => e.value).slice(0, 5),
            emailPattern: data.pattern ?? null,
            contactsFound: data.emails?.length ?? 0,
        };
    } catch (err) {
        log.warning(`Hunter.io failed for ${domain}: ${err.message}`);
        return {};
    }
}

// ─── TheirStack search ────────────────────────────────────────────────────────

async function searchCompanies({ technologySlug, countryCode, page = 0, limit = 100 }) {
    const body = {
        company_technology_slug_or: [technologySlug],
        page,
        limit,
        include_total_results: false,
    };

    if (countryCode) body.company_country_code_or = [countryCode];

    log.info('Request body: ' + JSON.stringify(body));

    const res = await fetch('https://api.theirstack.com/v1/companies/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${THEIRSTACK_API_KEY}`,
        },
        body: JSON.stringify(body),
    });

    if (res.status === 429) {
        log.warning('Rate limited — waiting 15s...');
        await new Promise(r => setTimeout(r, 15_000));
        return searchCompanies({ technologySlug, countryCode, page, limit });
    }

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`TheirStack API error ${res.status}: ${err}`);
    }

    const json = await res.json();
    return json?.data ?? [];
}

// ─── Client-side filters for industry and size ───────────────────────────────

function matchesFilters(company) {
    if (industry && !company.industry?.toLowerCase().includes(industry.toLowerCase())) return false;
    if (companySize) {
        const [min, max] = companySize.split('-').map(Number);
        const emp = company.num_employees ?? 0;
        if (companySize.endsWith('+')) {
            if (emp < parseInt(companySize)) return false;
        } else if (min && max) {
            if (emp < min || emp > max) return false;
        }
    }
    return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const limiter = pLimit(3);
const collected = [];
let page = 0;
const pageSize = 100;

while (collected.length < maxResults) {
    log.info(`Fetching page ${page}...`);

    const companies = await searchCompanies({ technologySlug, countryCode, page, limit: pageSize });

    if (!Array.isArray(companies) || companies.length === 0) {
        log.info('No more results.');
        break;
    }

    const filtered = companies.filter(matchesFilters);
    log.info(`Page ${page}: ${companies.length} total, ${filtered.length} after filters`);

    const enriched = await Promise.all(
        filtered.map(company =>
            limiter(async () => {
                if (collected.length >= maxResults) return null;
                const domain = company.domain ?? null;
                const hunterData = await enrichWithHunter(domain);
                return {
                    name:        company.name ?? null,
                    domain,
                    website:     company.website ?? null,
                    linkedin:    company.linkedin_url ?? null,
                    country:     company.country ?? null,
                    industry:    company.industry ?? null,
                    employees:   company.num_employees ?? null,
                    companySize: company.num_employees_range ?? null,
                    technology,
                    scrapedAt:   new Date().toISOString(),
                    ...hunterData,
                };
            })
        )
    );

    for (const c of enriched) {
        if (!c || collected.length >= maxResults) break;
        collected.push(c);
        await Actor.pushData(c);
    }

    log.info(`Collected ${collected.length} / ${maxResults}`);
    if (companies.length < pageSize) break;
    page++;
}

log.info(`✅ Done. Collected ${collected.length} companies.`);
await Actor.exit();
