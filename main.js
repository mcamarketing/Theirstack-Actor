/**
 * TheirStack Company Scraper — Production Build
 * Apify Actor | Playwright + Proxy Rotation + Concurrent Enrichment
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import pLimit from 'p-limit';

await Actor.init();

// ─── Input ────────────────────────────────────────────────────────────────────

const input = await Actor.getInput();
const {
    technology,
    country,
    industry,
    companySize,
    maxResults = 100,
    hunterApiKey = null,       // optional: Hunter.io for email enrichment
    proxyConfig: proxyInput,
} = input ?? {};

if (!technology) {
    log.error('"technology" is required. Exiting.');
    await Actor.exit({ exitCode: 1 });
}

// ─── Proxy ────────────────────────────────────────────────────────────────────

const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],   // use Apify residential proxies
    ...(proxyInput ?? {}),
});

// ─── Enrichment: Hunter.io (email finder) ─────────────────────────────────────

async function enrichWithHunter(domain) {
    if (!hunterApiKey || !domain) return {};
    try {
        const url = `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterApiKey}&limit=5`;
        const res = await fetch(url);
        if (!res.ok) return {};
        const json = await res.json();
        const data = json?.data ?? {};
        return {
            emails: (data.emails ?? []).map(e => e.value).slice(0, 5),
            emailPattern: data.pattern ?? null,
            contactsFound: data.emails?.length ?? 0,
        };
    } catch (err) {
        log.warning(`Hunter.io enrichment failed for ${domain}: ${err.message}`);
        return {};
    }
}

// ─── Enrichment: Domain → Clean URL ──────────────────────────────────────────

function extractDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

// ─── State ────────────────────────────────────────────────────────────────────

const collected = [];
const seen = new Set();
const limit = pLimit(5); // max 5 concurrent enrichment calls

// ─── Scraper ──────────────────────────────────────────────────────────────────

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    },
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,

    async requestHandler({ page, request }) {
        const pageNum = request.userData?.page ?? 1;
        log.info(`Scraping page ${pageNum} for technology: ${technology}`);

        // Wait for company cards to appear
        await page.waitForSelector('[data-testid="company-row"], .company-card, table tbody tr', {
            timeout: 20_000,
        }).catch(() => {
            log.warning('Company list selector not found — page structure may have changed.');
        });

        // ── Parse companies ──────────────────────────────────────────────────
        // NOTE: Selectors below target TheirStack's actual table layout.
        // Run `page.content()` and inspect if they stop working after a redesign.
        const companies = await page.evaluate(() => {
            const rows = document.querySelectorAll('[data-testid="company-row"]');
            return Array.from(rows).map(row => ({
                name:     row.querySelector('[data-testid="company-name"]')?.textContent?.trim() ?? null,
                website:  row.querySelector('[data-testid="company-website"] a')?.href ?? null,
                country:  row.querySelector('[data-testid="company-country"]')?.textContent?.trim() ?? null,
                industry: row.querySelector('[data-testid="company-industry"]')?.textContent?.trim() ?? null,
                size:     row.querySelector('[data-testid="company-size"]')?.textContent?.trim() ?? null,
                techsDetected: row.querySelector('[data-testid="tech-list"]')?.textContent?.trim() ?? null,
            }));
        });

        log.info(`Found ${companies.length} companies on page ${pageNum}`);

        // ── Filter ───────────────────────────────────────────────────────────
        const filtered = companies.filter(c => {
            if (seen.has(c.name)) return false;
            if (country    && !c.country?.toLowerCase().includes(country.toLowerCase()))    return false;
            if (industry   && !c.industry?.toLowerCase().includes(industry.toLowerCase()))  return false;
            if (companySize && !c.size?.toLowerCase().includes(companySize.toLowerCase())) return false;
            return c.name != null;
        });

        // ── Enrich concurrently ───────────────────────────────────────────────
        const enriched = await Promise.all(
            filtered.map(company =>
                limit(async () => {
                    if (collected.length >= maxResults) return null;
                    const domain = extractDomain(company.website);
                    const hunterData = await enrichWithHunter(domain);
                    return {
                        ...company,
                        domain,
                        scrapedAt: new Date().toISOString(),
                        technology,
                        ...hunterData,
                    };
                })
            )
        );

        for (const c of enriched) {
            if (!c || collected.length >= maxResults) break;
            seen.add(c.name);
            collected.push(c);
            await Actor.pushData(c);
        }

        log.info(`Total collected: ${collected.length} / ${maxResults}`);

        // ── Pagination ────────────────────────────────────────────────────────
        if (collected.length < maxResults) {
            const nextBtn = await page.$('[data-testid="next-page"], a[aria-label="Next page"]');
            if (nextBtn) {
                const nextUrl = await nextBtn.getAttribute('href');
                if (nextUrl) {
                    await crawler.addRequests([{
                        url: nextUrl.startsWith('http') ? nextUrl : `https://theirstack.com${nextUrl}`,
                        userData: { page: pageNum + 1 },
                    }]);
                }
            }
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

// ─── Kick off ─────────────────────────────────────────────────────────────────

const startUrl = `https://theirstack.com/technologies/${encodeURIComponent(technology)}`;

await crawler.run([{ url: startUrl, userData: { page: 1 } }]);

log.info(`✅ Done. Collected ${collected.length} companies.`);
await Actor.exit();
