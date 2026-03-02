import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue } from '@crawlee/cheerio';

await Actor.init();

/**
 * INPUT
 */
const input = await Actor.getInput();

const technologies = input?.technologies ?? [];

if (!technologies.length) {
    console.log('Field "technologies" is required');
    await Actor.exit();
}

/**
 * CREATE REQUEST QUEUE
 */
const requestQueue = await RequestQueue.open();

/**
 * ADD TECHNOLOGY URLS
 */
for (const tech of technologies) {
    const url = `https://theirstack.com/technologies/${tech}?limit=100`;

    await requestQueue.addRequest({
        url,
        userData: { tech },
    });
}

/**
 * CRAWLER
 * ❌ NO PROXY CONFIGURATION
 * Apify auto handles proxy
 */
const crawler = new CheerioCrawler({
    requestQueue,
    maxConcurrency: 5,

    async requestHandler({ request, $, body }) {
        console.log(`Processing ${request.url}`);

        const companies = [];

        $('a').each((i, el) => {
            const name = $(el).text().trim();
            const href = $(el).attr('href');

            if (href?.includes('/company/')) {
                companies.push({
                    technology: request.userData.tech,
                    company: name,
                    url: `https://theirstack.com${href}`,
                });
            }
        });

        console.log(`Found ${companies.length} companies`);

        if (companies.length) {
            await Actor.pushData(companies);
        }
    },

    failedRequestHandler({ request }) {
        console.log(`Request failed: ${request.url}`);
    },
});

console.log('Starting crawl...');
await crawler.run();

console.log('Crawl finished.');
await Actor.exit();
