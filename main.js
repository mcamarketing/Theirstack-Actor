const { Actor } = require('apify');
const { PlaywrightCrawler, Dataset, ProxyConfiguration } = require('@crawlee/playwright');

Actor.main(async () => {
    const input = await Actor.getInput();
    const {
        technologies,
        maxResults = 100,
        filters = {},
        proxyConfiguration
    } = input;

    const proxyConfig = new ProxyConfiguration(proxyConfiguration);
    const requestQueue = await Actor.openRequestQueue();

    for (const tech of technologies) {
        const url = `https://theirstack.com/en/technologies/${encodeURIComponent(tech)}`;
        await requestQueue.addRequest({ url, userData: { tech } });
    }

    const crawler = new PlaywrightCrawler({
        requestQueue,
        proxyConfiguration: proxyConfig,
        maxConcurrency: 5,
        launchContext: { launchOptions: { headless: true } },

        async requestHandler({ page, request, log }) {
            const { tech } = request.userData;
            log.info(`Scraping technology: ${tech}`);

            // Stealth anti-detection
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            await page.goto(request.url, { waitUntil: 'networkidle' });
            await page.waitForSelector('table');

            const companies = await page.evaluate(() => {
                const rows = document.querySelectorAll('table tbody tr');
                return Array.from(rows).map(row => {
                    const cols = row.querySelectorAll('td');
                    return {
                        company: cols[0]?.innerText?.trim(),
                        website: cols[1]?.innerText?.trim(),
                        industry: cols[2]?.innerText?.trim(),
                        employees: cols[3]?.innerText?.trim(),
                        location: cols[4]?.innerText?.trim(),
                    };
                });
            });

            for (const company of companies) {
                await Dataset.pushData({ technology: tech, ...company });
            }

            log.info(`Saved ${companies.length} companies`);
        },

        failedRequestHandler({ request }) {
            console.log(`Request failed: ${request.url}`);
        }
    });

    await crawler.run();
    console.log('Actor finished successfully');
});
