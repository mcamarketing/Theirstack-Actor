import { Actor } from 'apify';
import { CheerioCrawler, ProxyConfiguration, RequestQueue } from '@crawlee/cheerio';

await Actor.init();

// Get input safely
const input = await Actor.getInput();
const startUrls = Array.isArray(input?.startUrls) ? input.startUrls : [];

if (startUrls.length === 0) {
    console.log('No startUrls provided. Exiting...');
    await Actor.exit();
}

// Initialize request queue
const requestQueue = await RequestQueue.open();

for (const urlObj of startUrls) {
    if (urlObj?.url) {
        await requestQueue.addRequest({ url: urlObj.url });
    }
}

// Configure Apify proxy
const proxyConfiguration = new ProxyConfiguration({
    apifyProxyGroups: ['DEFAULT'], // use Apify proxy
});

// Create the crawler
const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency: 10,
    handlePageFunction: async ({ request, $ }) => {
        const result = {
            url: request.url,
            title: $('title').text() || null,
            // Add more scraping logic here
        };

        await Actor.pushData(result);
    },
    handleFailedRequestFunction: async ({ request }) => {
        console.log(`Request ${request.url} failed too many times.`);
    },
});

console.log('Starting crawl...');
await crawler.run();

console.log('Crawl finished, exiting Actor...');
await Actor.exit();
