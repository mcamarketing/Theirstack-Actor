import { Actor } from 'apify';
import { CheerioCrawler } from '@crawlee/cheerio';
import { ProxyConfiguration, RequestQueue } from '@crawlee/core';

await Actor.init();

// Initialize request queue
const requestQueue = await RequestQueue.open();

// Example: add start URLs from input
const { startUrls } = await Actor.getInput();
for (const urlObj of startUrls) {
    await requestQueue.addRequest({ url: urlObj.url });
}

// Configure Apify proxy
const proxyConfiguration = new ProxyConfiguration({
    apifyProxyGroups: ['DEFAULT'], // use Apify proxy
    // apifyProxySession: 'some-session-id', // optional
});

// Create the crawler
const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency: 10,
    handlePageFunction: async ({ request, $, body }) => {
        // Example: scrape company info
        const result = {
            url: request.url,
            title: $('title').text() || null,
            // Add more scraping logic here
        };

        // Save to default dataset
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
