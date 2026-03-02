import { Actor } from 'apify';
import { CheerioCrawler, ProxyConfiguration, RequestQueue } from '@crawlee/cheerio';

await Actor.init();

// Initialize request queue
const requestQueue = await RequestQueue.open();

// Example input
const input = await Actor.getInput();
const startUrls = Array.isArray(input.startUrls) ? input.startUrls : [];

if (!startUrls.length) {
    console.log('No startUrls provided. Exiting...');
    await Actor.exit();
}

// Add start URLs to queue
for (const urlObj of startUrls) {
    await requestQueue.addRequest({ url: urlObj.url });
}

// Configure proxy properly
const proxyConfiguration = new ProxyConfiguration({
    // Do not use apifyProxyGroups directly
    // Use 'apifyProxy' key only if you want Apify Proxy
    useApifyProxy: true,   // boolean
    groups: ['RESIDENTIAL'], // optional array of groups
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
