import { Actor } from 'apify';

await Actor.init();

const input = await Actor.getInput();

const {
    technologies = [],
    country,
    industry,
    companySize,
    maxResults = 100,
} = input ?? {};

if (!technologies.length) {
    throw new Error('Field "technologies" is required');
}

/**
 * THEIRSTACK QUERY BUILDER
 */
function buildQuery(tech, offset = 0) {
    const params = new URLSearchParams({
        technology: tech,
        limit: 100,
        offset,
    });

    if (country) params.append('country', country);
    if (industry) params.append('industry', industry);
    if (companySize) params.append('companySize', companySize);

    return `https://theirstack.com/api/companies?${params.toString()}`;
}

/**
 * FETCH LOOP
 */
for (const tech of technologies) {

    let offset = 0;
    let collected = 0;
    let hasMore = true;

    while (hasMore && collected < maxResults) {

        const url = buildQuery(tech, offset);

        console.log(`Fetching ${url}`);

        const res = await fetch(url, {
            headers: {
                'accept': 'application/json',
                'user-agent': 'Mozilla/5.0',
            },
        });

        if (!res.ok) break;

        const data = await res.json();

        const companies = data?.companies ?? [];

        if (!companies.length) break;

        const normalized = companies.map(c => ({
            technology: tech,
            name: c.name,
            website: c.website,
            country: c.country,
            industry: c.industry,
            companySize: c.companySize,
            linkedin: c.linkedin,
        }));

        await Actor.pushData(normalized);

        collected += companies.length;
        offset += companies.length;

        hasMore = companies.length > 0;
    }
}

console.log('Finished scraping.');

await Actor.exit();
