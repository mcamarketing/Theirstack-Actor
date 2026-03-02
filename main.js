import { Actor } from 'apify';
import { CheerioCrawler, ProxyConfiguration, RequestQueue } from '@crawlee/cheerio';

await Actor.init();

const input = await Actor.getInput();
const { technologies = [], maxResultsPerTechnology = 100, filters = {} } = input;

if (technologies.length === 0) {
    console.log('No technologies provided. Exiting...');
    await Actor.exit();
}

const requestQueue = await RequestQueue.open();

// Generate start URLs from technologies and filters
for (const tech of technologies) {
    let url = `https://theirstack.com/companies?technology=${encodeURIComponent(tech)}`;
    if (filters.country) url += `&country=${encodeURIComponent(filters.country)}`;
    if (filters.industry) url += `&industry=${encodeURIComponent(filters.industry)}`;
    if (filters.companySize) url += `&companySize=${encodeURIComponent(filters.companySize)}`;
    
    await requestQueue.addRequest({ url });
}

const proxyConfiguration = new ProxyConfiguration({
    apifyProxyGroups: ['RESIDENTIAL'],
});

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
