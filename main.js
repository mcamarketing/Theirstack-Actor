import { Actor, log } from 'apify';
import fetch from 'node-fetch';

await Actor.init();

/**
 * ===============================
 * GET INPUT
 * ===============================
 */
const input = await Actor.getInput();

const {
    technology,
    country,
    industry,
    companySize,
    maxResults = 50,
} = input || {};

if (!technology) {
    throw new Error('Technology is required.');
}

log.info(`Starting scrape for technology: ${technology}`);

/**
 * ===============================
 * BUILD QUERY URL
 * ===============================
 */

const BASE_URL = 'https://theirstack.com/api/companies';

const buildUrl = (page = 1) => {
    const params = new URLSearchParams();

    params.append('technology', technology);
    params.append('page', page);

    if (country) params.append('country', country);
    if (industry) params.append('industry', industry);
    if (companySize) params.append('company_size', companySize);

    return `${BASE_URL}?${params.toString()}`;
};

/**
 * ===============================
 * FETCH DATA
 * ===============================
 */

const results = [];
let page = 1;
let keepScraping = true;

while (keepScraping && results.length < maxResults) {
    const url = buildUrl(page);

    log.info(`Fetching page ${page}`);
    log.debug(url);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'ApifyActor-TheProphet.ai',
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const json = await response.json();

        const companies = json.data || json.results || [];

        if (!companies.length) {
            log.info('No more companies found.');
            break;
        }

        /**
         * ===============================
         * NORMALIZE OUTPUT
         * ===============================
         */

        for (const company of companies) {
            results.push({
                companyName: company.name || null,
                website: company.website || null,
                country: company.country || null,
                industry: company.industry || null,
                companySize: company.company_size || null,
                technologies: company.technologies || [],
                linkedin: company.linkedin || null,
                source: 'TheirStack',
            });

            if (results.length >= maxResults) break;
        }

        page++;

    } catch (err) {
        log.error(`Failed on page ${page}`, err);
        keepScraping = false;
    }
}

/**
 * ===============================
 * SAVE DATASET
 * ===============================
 */

if (!results.length) {
    log.warning('No results collected.');
} else {
    await Actor.pushData(results);
}

log.info(`Finished. Collected ${results.length} companies.`);

await Actor.exit();
