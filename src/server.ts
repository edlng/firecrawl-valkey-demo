import express from "express";
import path from "path";
import { GlideClient } from "@valkey/valkey-glide";
import { config } from "./config";
import { FirecrawlClient } from "./firecrawl-client";
import { startDependencies, setupShutdownHandler } from "./startup";
import { getValkeyClient, RateLimiter } from "./services/rate-limiter";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const firecrawl = new FirecrawlClient();
let rateLimiter: RateLimiter;
let valkeyClient: GlideClient;

// Rate limit middleware
const rateLimit = (endpoint: "scrape" | "crawl" | "batch") => {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const result = await rateLimiter.consume(endpoint);
    
    if (!result.allowed) {
      return res.status(429).json({
        error: `Rate limit exceeded. Retry after ${result.retryAfter}s`,
        retryAfter: result.retryAfter,
      });
    }
    
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    next();
  };
};

// Health check
app.get("/api/health", async (_req, res) => {
  try {
    const response = await fetch(config.firecrawl.apiUrl);
    if (!response.ok) throw new Error("Firecrawl not responding");
    res.json({ status: "ok" });
  } catch (error: any) {
    res.status(500).json({ status: "error", error: error.message });
  }
});

// Rate limit status endpoint
app.get("/api/rate-limits", async (_req, res) => {
  const [scrape, crawl, batch] = await Promise.all([
    rateLimiter.getStatus("scrape"),
    rateLimiter.getStatus("crawl"),
    rateLimiter.getStatus("batch"),
  ]);
  res.json({ scrape, crawl, batch });
});

// Rate-limited demo endpoint (for the rate limiting panel)
app.post("/api/demo/rate-limited", rateLimit("scrape"), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const startTime = Date.now();
    const result = await firecrawl.scrape(url, { formats: ["markdown"] });
    const elapsed = Date.now() - startTime;
    return res.json({ ...result, elapsed });
  } catch (error: any) {
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message, status });
  }
});

// Scrape
app.post("/api/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const startTime = Date.now();
    const result = await firecrawl.scrape(url, { formats: ["markdown"] });
    const elapsed = Date.now() - startTime;
    return res.json({ ...result, elapsed });
  } catch (error: any) {
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message, status });
  }
});

// Crawl
app.post("/api/crawl", async (req, res) => {
  const { url, limit = 5 } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const result = await firecrawl.crawl(url, { limit });
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/crawl/:id", async (req, res) => {
  try {
    const result = await firecrawl.getCrawlStatus(req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Batch
app.post("/api/batch", async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "URLs array required" });
  }

  try {
    const result = await firecrawl.batchScrape(urls, { formats: ["markdown"] });
    return res.json(result);
  } catch (error: any) {
    console.error("[Batch] Error:", error.response?.data || error.message);
    const status = error.response?.status || 500;
    const message = error.response?.data?.error || error.message;
    return res.status(status).json({ success: false, error: message });
  }
});

app.get("/api/batch/:id", async (req, res) => {
  try {
    const result = await firecrawl.getBatchScrapeStatus(req.params.id);
    res.json(result);
  } catch (error: any) {
    console.error("[Batch Status] Error:", error.response?.data || error.message);
    const status = error.response?.status || 500;
    const message = error.response?.data?.error || error.message;
    res.status(status).json({ success: false, error: message });
  }
});

// Valkey Inspector - inspect Firecrawl's crawl keys
app.get("/api/valkey/crawl/:id", async (req, res) => {
  const crawlId = req.params.id;
  
  try {
    // These are the key patterns Firecrawl uses (from crawl-redis.ts)
    const keys = [
      { key: `crawl:${crawlId}`, type: "string", desc: "Crawl config & options" },
      { key: `crawl:${crawlId}:jobs`, type: "set", desc: "All job IDs" },
      { key: `crawl:${crawlId}:jobs_done`, type: "set", desc: "Completed job IDs" },
      { key: `crawl:${crawlId}:visited`, type: "set", desc: "Visited URLs" },
      { key: `crawl:${crawlId}:visited_unique`, type: "set", desc: "Unique visited URLs" },
      { key: `crawl:${crawlId}:robots_blocked`, type: "set", desc: "URLs blocked by robots.txt" },
    ];

    const results: Record<string, any> = {};

    for (const { key, type, desc } of keys) {
      try {
        let value: any = null;
        let size: number | null = null;

        if (type === "string") {
          const raw = await valkeyClient.get(key);
          if (raw) {
            try {
              value = JSON.parse(String(raw));
            } catch {
              value = String(raw);
            }
          }
        } else if (type === "set") {
          size = Number(await valkeyClient.scard(key));
          // Get first few members as sample
          const membersSet = await valkeyClient.smembers(key);
          const members = Array.from(membersSet).map(m => String(m));
          value = members.slice(0, 10); // Limit to 10 for display
          if (members.length > 10) {
            value.push(`... and ${members.length - 10} more`);
          }
        }

        const ttl = await valkeyClient.ttl(key);

        results[key] = {
          exists: value !== null || (size !== null && size > 0),
          type,
          desc,
          size,
          ttl: ttl > 0 ? ttl : null,
          value,
        };
      } catch (e) {
        results[key] = { exists: false, type, desc, error: String(e) };
      }
    }

    // Also check if this crawl is in active_crawls
    try {
      const isActive = await valkeyClient.sismember("active_crawls", crawlId);
      results["active_crawls"] = {
        exists: true,
        type: "set",
        desc: "Is this crawl active?",
        value: isActive ? "Yes" : "No",
      };
    } catch {
      results["active_crawls"] = { exists: false, type: "set", desc: "Is this crawl active?" };
    }

    res.json({ crawlId, keys: results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3030;

async function main() {
  // Start Docker services first (Firecrawl + Valkey)
  const ready = await startDependencies(config.firecrawl.apiUrl);
  if (!ready) {
    console.error("[Server] Failed to start dependencies, exiting");
    process.exit(1);
  }

  // Now connect to Valkey (after docker compose is up)
  valkeyClient = await getValkeyClient(config.valkey.host, config.valkey.port);
  rateLimiter = new RateLimiter(valkeyClient, config.rateLimits);
  console.log("[RateLimiter] Initialized with limits:", config.rateLimits);

  setupShutdownHandler();

  app.listen(PORT, () => {
    console.log(`\n[Server] Valkey Demo running at http://localhost:${PORT}`);
    console.log(`         Firecrawl API: ${config.firecrawl.apiUrl}\n`);
  });
}

main().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
