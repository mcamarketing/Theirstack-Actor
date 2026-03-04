/**
 * TheirStack Company Scraper — API Build
 * Apify Actor | TheirStack API + Optional Hunter.io Enrichment
 */

import { Actor, log } from 'apify';
import pLimit from 'p-limit';

await Actor.init();

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

// Resolve "Other" selections
const technology = technologyRaw === 'Other' ? customTechnology : technologyRaw;
const country    = countryRaw    === 'Other' ? customCountry    : countryRaw;
const industry   = industryRaw   === 'Other' ? customIndustry   : industryRaw;

if (!technology || technology.trim() === '') {
    log.error('"technology" is required.');
    await Actor.exit({ exitCode: 1 });
}

// ─── TheirStack API Key (stored as Apify secret) ──────────────────────────────

const THEIRSTACK_API_KEY = process.env.THEIRSTACK_API_KEY;

if (!THEIRSTACK_API_KEY) {
    log.error('THEIRSTACK_API_KEY environment variable is not set. Add it in Actor Settings → Environment Variables.');
    await Actor.exit({ exitCode: 1 });
}

log.info(`Starting — Technology: ${technology} | Country: ${country ?? 'any'} | Industry: ${industry ?? 'any'} | Size: ${companySize ?? 'any'} | Max: ${maxResults}`);

// ─── Enrichment: Hunter.io ────────────────────────────────────────────────────

async function enrichWithHunter(domain) {
    if (!hunterApiKey || !domain) return {};
    try {
        const url = `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterApiKey}&limit=5`;
        const res = await fetch(url);
        if (!res.ok) return {};
        const json = await res.json();
        const data = json?.data ?? {};
        return {
            emails: (data.emails ?? []).map(e => e.value).slice(0, 5),
            emailPattern: data.pattern ?? null,
            contactsFound: data.emails?.length ?? 0,
        };
    } catch (err) {
        log.warning(`Hunter.io enrichment failed for ${domain}: ${err.message}`);
        return {};
    }
}

// ─── TheirStack API Search ────────────────────────────────────────────────────

async function searchCompanies({ technology, country, industry, companySize, page = 0, limit = 100 }) {
    const body = {
        technology_slugs: [technology],
        page,
        limit,
        include_total_results: false,
    };

    if (country)     body.company_country_name_partial_match = [country];
    if (industry)    body.company_industry_partial_match = [industry];
    if (companySize) body.company_num_employees_ranges = [companySize];

    const res = await fetch('https://api.theirstack.com/v1/companies/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${THEIRSTACK_API_KEY}`,
        },
        body: JSON.stringify(body),
    });

    if (res.status === 429) {
        log.warning('Rate limited by TheirStack API — waiting 15 seconds...');
        await new Promise(r => setTimeout(r, 15_000));
        return searchCompanies({ technology, country, industry, companySize, page, limit });
    }

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`TheirStack API error ${res.status}: ${err}`);
    }

    const json = await res.json();
    return json?.data ?? [];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const limit = pLimit(3);
const collected = [];
let page = 0;
const pageSize = Math.min(100, maxResults);

while (collected.length < maxResults) {
    log.info(`Fetching page ${page}...`);

    const companies = await searchCompanies({
        technology,
        country,
        industry,
        companySize,
        page,
        limit: pageSize,
    });

    if (!companies.length) {
        log.info('No more results from TheirStack.');
        break;
    }

    // Enrich concurrently with Hunter.io
    const enriched = await Promise.all(
        companies.map(company =>
            limit(async () => {
                if (collected.length >= maxResults) return null;
                const domain = company.domain ?? null;
                const hunterData = await enrichWithHunter(domain);
                return {
                    name:        company.name ?? null,
                    domain:      domain,
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

    if (companies.length < pageSize) break; // last page
    page++;
}

log.info(`✅ Done. Collected ${collected.length} companies.`);
await Actor.exit();
