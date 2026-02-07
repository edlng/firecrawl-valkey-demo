# Firecrawl + Valkey Demo

A demo that lets you see inside Firecrawl's Valkey usage in real-time. Start scrapes and crawls, then inspect the actual keys, queues, and state that Firecrawl creates in Valkey.

## What This Shows

- **Rate Limiting** — Sliding window rate limiter using Valkey sorted sets, matching Firecrawl's production pattern
- **Crawl State Management** — See how Firecrawl stores all crawl state in Valkey (config, jobs, visited URLs)
- **Valkey Inspector** — View the actual keys Firecrawl creates for your crawls in real-time
- **Batch Operations** — Queue multiple URLs with progress tracked in Valkey

> **Note:** Self-hosted Firecrawl uses mock authentication which disables rate limiting (all limits set to 99999999). This demo implements its own rate limiting layer using Valkey to demonstrate the pattern Firecrawl uses in production.

## Quick Start

```bash
pnpm install
pnpm run server

# Opens at http://localhost:3030
# Automatically starts Firecrawl + Valkey via docker compose
```

The server will automatically run `docker compose` to start Firecrawl and Valkey.

## How It Works

The demo server:
1. Starts Firecrawl + Valkey via docker compose
2. Proxies requests to Firecrawl's real API (scrape, crawl, batch)
3. Implements rate limiting using Valkey GLIDE (same pattern as Firecrawl production)
4. Provides a **Valkey Inspector** to see the actual keys Firecrawl creates in real-time

## Rate Limiting

The rate limiting panel demonstrates Valkey-based rate limiting using a sliding window algorithm with sorted sets — the same approach Firecrawl uses in production.

The demo endpoint is limited to 10 requests/minute by default (configurable via `RATE_LIMIT_SCRAPE`). The other endpoints (scrape, crawl, batch) are unlimited since they go directly to Firecrawl.

## Firecrawl's Valkey Usage

Firecrawl stores **all crawl state** in Valkey:

| Pattern | Type | Purpose |
|---------|------|---------|
| `crawl:{id}` | string (JSON) | Crawl configuration, options, team_id, timestamps |
| `crawl:{id}:jobs` | set | All job IDs for this crawl |
| `crawl:{id}:jobs_done` | set | Completed job IDs |
| `crawl:{id}:visited` | set | URLs already visited (prevents duplicates)* |
| `crawl:{id}:visited_unique` | set | Unique URLs visited* |
| `crawl:{id}:robots_blocked` | set | URLs blocked by robots.txt |
| `active_crawls` | set | Currently running crawl IDs |

All keys have a 24-hour TTL.

*\*Note: `visited` and `visited_unique` sets are deleted when a crawl completes to save memory.*

### Demo-Specific Keys

| Pattern | Type | Purpose |
|---------|------|---------|
| `ratelimit:{endpoint}:{id}` | sorted set | Sliding window rate limiting |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRECRAWL_API_URL` | `http://localhost:3002` | Firecrawl API endpoint |
| `FIRECRAWL_API_KEY` | `fc-test-key` | API key |
| `VALKEY_HOST` | `localhost` | Valkey/Redis host |
| `VALKEY_PORT` | `6379` | Valkey/Redis port |
| `RATE_LIMIT_SCRAPE` | `10` | Rate limit demo requests per minute |
| `SKIP_DOCKER` | `false` | Skip docker compose if running separately |

## Benchmark

To run benchmarking analysis against Valkey or Redis, open `deploy/docker-compose.yaml` and modify the following lines as needed:

```yaml
  redis:
    image: valkey/valkey:alpine
    # image: redis:alpine
```

Then, in one terminal run:

```bash
cd deploy
docker compose down -v # removes existing containers and vols
docker compose up
```

In another terminal, run:

```bash
LABEL=valkey pnpm run benchmark # for Valkey
LABEL=redis pnpm run benchmark # for Redis
```

The benchmark tests Firecrawl's performance using Redis vs Valkey as the backing store. It measures real API operations (not synthetic Redis commands) to capture end-to-end performance including queue management, job processing, and state storage.

**Key characteristics**:

1. **Local test pages** - Uses an nginx container serving static HTML pages (`simple.html`, `article.html`, `complex.html`) to eliminate network variance from external URLs

2. **Operations tested**:
    - `scrape` - Single URL scrape requests (300 iterations default)
    - `batchScrape` - Batch scrape job creation (60 iterations)
    - `crawl` - Crawl job initiation (30 iterations)
    - `map` - URL mapping operations (150 iterations)
    - `mixedWorkload` - Randomized mix of all operations (300 iterations)

3. **Statistical rigor**:
    - Multiple runs per operation (default: 5)
    - Multiple suite runs (default: 3)
    - Reports ops/sec with standard deviation
    - Latency percentiles (p50, p95, p99)
    - Success rate tracking

4. **Baseline measurements**:
    - Redis/Valkey PING latency (raw cache performance)
    - Network latency to test URLs (context for variance)

5. **Memory tracking**:
    - Peak memory usage during benchmark
    - Final memory after completion