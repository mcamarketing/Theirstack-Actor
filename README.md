# 🔍 Theirstack Actor — Find Companies by Technology

Scrape companies from [TheirStack](https://theirstack.com) based on the technologies they use. Filter by country, industry, or company size to build laser-targeted B2B lead lists — no TheirStack API key required.

---

## 🚀 What You Can Do With This

| Use Case | Example |
|---|---|
| **Sales prospecting** | Find 500 US SaaS companies using Stripe — then pitch your payment analytics tool |
| **Competitor research** | See which companies use your competitor's stack |
| **Market sizing** | Discover how many mid-market companies in Europe use Salesforce |
| **Agency lead gen** | Build niche lists for clients by tech + geography + company size |
| **VC research** | Track adoption trends of emerging technologies across startups |

---

## ⚙️ Input

```json
{
  "technology": "Stripe",
  "country": "United States",
  "industry": "SaaS",
  "companySize": "11-50",
  "maxResults": 100,
  "hunterApiKey": "your-hunter-key-optional"
}
```

| Field | Required | Preset Options |
|---|---|---|
| `technology` | ✅ Yes | `Stripe` · `Salesforce` · `HubSpot` · `React` · `Shopify` · `Intercom` · `Zendesk` · `AWS` · `Twilio` · `Segment` · **Other** (type any technology name) |
| `country` | No | `United States` · `United Kingdom` · `Germany` · `France` · `Canada` · `Australia` · `Netherlands` · `India` · `Spain` · `Brazil` · **Other** (type any country) |
| `industry` | No | `SaaS` · `Fintech` · `E-commerce` · `Healthtech` · `Edtech` · `Marketing` · `Logistics` · `Real Estate` · `HR Tech` · `Cybersecurity` · **Other** (type any industry) |
| `companySize` | No | `1-10` · `11-50` · `51-200` · `201-500` · `501-1000` · `1001-5000` · `5000+` |
| `maxResults` | No | `25` · `50` · `100` · `250` · `500` · `1000` · **Other** (enter any number up to 5000, default: 100) |
| `hunterApiKey` | No | Your [Hunter.io](https://hunter.io) API key — enables verified email enrichment |
| `proxyConfig` | No | Apify proxy configuration (residential recommended for reliability) |

---

## 📦 Sample Output

Each result in the dataset looks like this:

```json
{
  "company": "Acme Corp",
  "domain": "acmecorp.com",
  "industry": "SaaS",
  "country": "United States",
  "employeeCount": 42,
  "companySize": "11-50",
  "technologies": ["Stripe", "React", "AWS"],
  "linkedinUrl": "https://linkedin.com/company/acmecorp",
  "description": "Acme Corp builds invoicing software for freelancers.",
  "emailPattern": "{first}.{last}@acmecorp.com",
  "verifiedEmails": [
    {
      "name": "Jane Smith",
      "email": "jane.smith@acmecorp.com",
      "position": "Head of Growth",
      "confidence": 94
    }
  ]
}
```

> ℹ️ `emailPattern` and `verifiedEmails` are only populated when a Hunter.io API key is provided.

---

## 💡 Example Queries

**Find Stripe users in US SaaS companies (11–200 employees)**
```json
{
  "technology": "Stripe",
  "country": "United States",
  "industry": "SaaS",
  "companySize": "11-50",
  "maxResults": 200
}
```

**Find European companies using Salesforce (any size)**
```json
{
  "technology": "Salesforce",
  "country": "Germany",
  "maxResults": 500
}
```

**Find React users in Fintech + enrich with emails**
```json
{
  "technology": "React",
  "industry": "Fintech",
  "maxResults": 100,
  "hunterApiKey": "your-hunter-api-key"
}
```

---

## 🔌 Integration

### JavaScript
```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });

const run = await client.actor("ernesta_labs/theirstack-actor").call({
  technology: "Stripe",
  country: "United States",
  industry: "SaaS",
  companySize: "11-50",
  maxResults: 100
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items);
```

### Python
```python
from apify_client import ApifyClient

client = ApifyClient("YOUR_API_TOKEN")

run = client.actor("ernesta_labs/theirstack-actor").call(run_input={
    "technology": "Stripe",
    "country": "United States",
    "industry": "SaaS",
    "companySize": "11-50",
    "maxResults": 100
})

for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(item)
```

---

## 💰 Pricing

This Actor uses a **pay-per-event** model, starting at **$3.00 per batch**. Pricing decreases automatically on higher Apify subscription plans.

You only pay for what you use — no subscriptions, no minimums.

---

## ❓ FAQ

**Do I need a TheirStack account or API key?**
No. The Actor handles access for you — just provide your Apify token.

**How fresh is the data?**
Data is scraped live from TheirStack at the time of your run.

**Can I get email addresses?**
Yes — connect your [Hunter.io](https://hunter.io) API key via the `hunterApiKey` field to enrich results with verified emails and contact patterns.

**What's the maximum number of results?**
Up to 5,000 companies per run.

**Is residential proxy recommended?**
Yes, for best reliability. You can configure this via the `proxyConfig` field using Apify's proxy settings.

---

## 🛠️ Built by [Riccardo Minniti](https://apify.com/ernesta_labs)

Questions or feature requests? Open an issue or reach out via the Apify community.
