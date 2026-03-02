import { Actor } from 'apify';
import { CheerioCrawler, ProxyConfiguration, RequestQueue } from '@crawlee/core';

await Actor.init();

// Initialize request queue
const requestQueue = await RequestQueue.open();

// Add start URLs from input
const { startUrls } = await Actor.getInput();
for (const urlObj of startUrls) {
    await requestQueue.addRequest({ url: urlObj.url });
}

// Configure Apify proxy (corrected)
const proxyConfiguration = new ProxyConfiguration({
    apifyProxyGroups: ['DEFAULT'], // use Apify proxy
    // Do NOT include `useApifyProxy` anymore
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
