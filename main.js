import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue, ProxyConfiguration } from '@crawlee/cheerio';

await Actor.init();

// Get input from the form
const input = await Actor.getInput();
const { technologies = [], maxResults = 100 } = input;

// Validate
if (!technologies.length) {
    console.log('No technologies provided. Exiting...');
    await Actor.exit();
}

// Build start URLs from technologies
const startUrls = technologies.map(tech => ({
    url: `https://theirstack.com/technologies/${tech}?limit=${maxResults}`
}));

// Initialize request queue
const requestQueue = await RequestQueue.open();
for (const urlObj of startUrls) {
    await requestQueue.addRequest({ url: urlObj.url });
}

// Configure default proxy (no need to set apifyProxyGroups manually)
const proxyConfiguration = new ProxyConfiguration();

// Create crawler
const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency: 10,
    handlePageFunction: async ({ request, $ }) => {
        // Example scraping logic
        const results = [];
        $('.company-card a').each((_, el) => {
            const link = $(el).attr('href');
            const name = $(el).find('.company-name').text().trim();
            if (link && name) results.push({ name, url: `https://theirstack.com${link}` });
        });

        for (const res of results) {
            await Actor.pushData(res);
        }
    },
    handleFailedRequestFunction: async ({ request }) => {
        console.log(`Request ${request.url} failed too many times.`);
    },
});

console.log('Starting crawl...');
await crawler.run();
console.log('Crawl finished. Exiting Actor...');
await Actor.exit();
