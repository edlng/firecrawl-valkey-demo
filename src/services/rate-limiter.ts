import { GlideClient } from "@valkey/valkey-glide";

// --- Valkey Client ---

let client: GlideClient | null = null;

export async function getValkeyClient(host: string, port: number): Promise<GlideClient> {
  if (client) return client;

  client = await GlideClient.createClient({
    addresses: [{ host, port }],
  });

  console.log("[Valkey] Connected to", `${host}:${port}`);
  return client;
}

export async function closeValkeyClient(): Promise<void> {
  if (client) {
    client.close();
    client = null;
    console.log("[Valkey] Connection closed");
  }
}

// --- Rate Limiter ---

export interface RateLimits {
  scrape: number;
  crawl: number;
  batch: number;
}

const DEFAULT_RATE_LIMITS: RateLimits = {
  scrape: 10,  // 10 requests per minute
  crawl: 5,    // 5 requests per minute
  batch: 3,    // 3 requests per minute
};

const WINDOW_SECONDS = 60;

export class RateLimiter {
  private client: GlideClient;
  private limits: RateLimits;

  constructor(client: GlideClient, limits: Partial<RateLimits> = {}) {
    this.client = client;
    this.limits = { ...DEFAULT_RATE_LIMITS, ...limits };
  }

  /**
   * Sliding window rate limiter using sorted sets (same pattern as Firecrawl)
   * Returns { allowed: true, remaining } or { allowed: false, retryAfter }
   */
  async consume(
    endpoint: "scrape" | "crawl" | "batch",
    identifier: string = "default"
  ): Promise<{ allowed: true; remaining: number } | { allowed: false; retryAfter: number }> {
    const key = `ratelimit:${endpoint}:${identifier}`;
    const limit = this.limits[endpoint];
    const now = Date.now();
    const windowStart = now - WINDOW_SECONDS * 1000;

    // Remove old entries outside the window
    await this.client.zremRangeByScore(key, { value: 0 }, { value: windowStart });

    // Count current requests in window
    const currentCount = await this.client.zcard(key);

    if (currentCount >= limit) {
      // Get the oldest entry to calculate retry time
      const oldest = await this.client.zrange(key, { start: 0, end: 0 });
      let retryAfter = WINDOW_SECONDS;
      
      if (oldest && oldest.length > 0) {
        const oldestTime = await this.client.zscore(key, oldest[0]);
        if (oldestTime !== null) {
          retryAfter = Math.ceil((oldestTime + WINDOW_SECONDS * 1000 - now) / 1000);
        }
      }

      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }

    // Add current request
    const requestId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    await this.client.zadd(key, [{ element: requestId, score: now }]);
    
    // Set expiry on the key
    await this.client.expire(key, WINDOW_SECONDS + 1);

    return { allowed: true, remaining: limit - Number(currentCount) - 1 };
  }

  /**
   * Get current rate limit status without consuming
   */
  async getStatus(
    endpoint: "scrape" | "crawl" | "batch",
    identifier: string = "default"
  ): Promise<{ used: number; limit: number; remaining: number }> {
    const key = `ratelimit:${endpoint}:${identifier}`;
    const limit = this.limits[endpoint];
    const now = Date.now();
    const windowStart = now - WINDOW_SECONDS * 1000;

    await this.client.zremRangeByScore(key, { value: 0 }, { value: windowStart });
    const used = await this.client.zcard(key);

    return {
      used: Number(used),
      limit,
      remaining: Math.max(0, limit - Number(used)),
    };
  }

  getLimits(): RateLimits {
    return { ...this.limits };
  }
}
