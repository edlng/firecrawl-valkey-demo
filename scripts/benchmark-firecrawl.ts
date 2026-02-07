#!/usr/bin/env npx ts-node
/**
 * Firecrawl Scale Benchmark
 * 
 * Tests real Firecrawl API operations to measure Redis/Valkey performance
 * in production-like conditions. Calls actual Firecrawl endpoints which
 * exercise BullMQ/NuQ queue operations internally.
 * 
 * Prerequisites:
 *   - Firecrawl API running locally (default: http://localhost:3002)
 *   - Valid FIRECRAWL_API_KEY
 *   - Redis or Valkey instance configured in Firecrawl
 * 
 * Usage:
 *   LABEL=redis pnpm run benchmark:scale
 *   LABEL=valkey pnpm run benchmark:scale
 *   pnpm run benchmark:scale --compare
 */

import axios, { AxiosInstance } from "axios";
import { GlideClient, InfoOptions } from "@valkey/valkey-glide";
import * as fs from "fs";
import * as path from "path";

const CONFIG = {
  // Firecrawl API
  apiUrl: process.env.FIRECRAWL_API_URL || "http://localhost:3002",
  apiKey: process.env.FIRECRAWL_API_KEY || "fc-test",
  
  // Scale parameters (increased for statistical significance)
  scrapeIterations: parseInt(process.env.SCRAPE_ITERATIONS || "300"),
  batchSize: parseInt(process.env.BATCH_SIZE || "10"),
  crawlLimit: parseInt(process.env.CRAWL_LIMIT || "20"),
  concurrency: parseInt(process.env.CONCURRENCY || "10"),
  runs: parseInt(process.env.RUNS || "5"),
  
  // Multi-run mode: repeat entire benchmark suite multiple times
  suiteRuns: parseInt(process.env.SUITE_RUNS || "3"),
  
  // Redis connection (for memory stats only)
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: parseInt(process.env.REDIS_PORT || "6379"),
  label: process.env.LABEL || "redis",
};

const RESULTS_DIR = path.join(__dirname, "../benchmark-results");

// Test URLs - use local nginx for consistent benchmarking (eliminates network variance)
// Set USE_LOCAL_PAGES=true and ensure benchmark-nginx container is running
// Firecrawl runs in Docker, so it needs the Docker network hostname (benchmark-nginx)
// But baseline measurements run from host, so they use localhost:8080
// const USE_LOCAL_PAGES = process.env.USE_LOCAL_PAGES === "true";
const USE_LOCAL_PAGES = true; // Hardcode

// URLs for Firecrawl API (inside Docker network)
const DOCKER_BASE_URL = "http://benchmark-nginx";
// URLs for baseline network measurements (from host)
const HOST_BASE_URL = "http://localhost:8080";

const TEST_URLS = USE_LOCAL_PAGES
  ? [
      `${DOCKER_BASE_URL}/simple.html`,
      `${DOCKER_BASE_URL}/article.html`,
      `${DOCKER_BASE_URL}/complex.html`,
    ]
  : [
      "https://example.com",
      "https://httpbin.org/html",
      "https://jsonplaceholder.typicode.com",
    ];

// URLs for baseline measurements (always accessible from host)
const BASELINE_URLS = USE_LOCAL_PAGES
  ? [
      `${HOST_BASE_URL}/simple.html`,
      `${HOST_BASE_URL}/article.html`,
      `${HOST_BASE_URL}/complex.html`,
    ]
  : TEST_URLS;

interface LatencyStats {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface BenchmarkResult {
  name: string;
  iterations: number;
  runs: number;
  avgOpsPerSecond: number;
  opsPerSecondStdDev: number;
  latency: LatencyStats;
  successRate: number;
  errors: string[];
}

interface BaselineMetrics {
  networkLatency: LatencyStats;
  redisLatency: LatencyStats;
  urlLatencies: { url: string; avgMs: number; samples: number }[];
}

interface ScaleBenchmarkSuite {
  label: string;
  timestamp: string;
  config: typeof CONFIG;
  serverInfo: string;
  baselines: BaselineMetrics;
  results: BenchmarkResult[];
  memoryPeakMB: number;
  memoryFinalMB: number;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stdDev(arr: number[]): number {
  if (arr.length === 0) return 0;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  const squareDiffs = arr.map(v => Math.pow(v - avg, 2));
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / arr.length);
}

function createApiClient(): AxiosInstance {
  return axios.create({
    baseURL: CONFIG.apiUrl,
    headers: {
      "Authorization": `Bearer ${CONFIG.apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 120000, // 2 min timeout for crawls
  });
}

// ============================================================================
// Baseline Measurements (Network & Redis/Valkey latency)
// ============================================================================

async function measureNetworkLatency(url: string, samples: number = 10): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    try {
      await axios.head(url, { timeout: 5000 });
      latencies.push(performance.now() - start);
    } catch {
      // Skip failed requests
    }
  }
  return latencies;
}

async function measureRedisLatency(client: GlideClient, samples: number = 100): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    try {
      await client.ping();
      latencies.push(performance.now() - start);
    } catch {
      // Skip failed pings
    }
  }
  return latencies;
}

async function measureBaselines(cacheClient: GlideClient): Promise<BaselineMetrics> {
  console.log("\n📡 Measuring baseline latencies...");
  
  // Measure Redis/Valkey PING latency
  process.stdout.write("  Redis/Valkey PING latency... ");
  const redisLatencies = await measureRedisLatency(cacheClient, 100);
  const redisStats = computeLatencyStats(redisLatencies);
  console.log(`avg ${redisStats.avg.toFixed(2)}ms, p99 ${redisStats.p99.toFixed(2)}ms`);
  
  // Measure network latency to each test URL (use BASELINE_URLS for host-accessible URLs)
  const urlLatencies: { url: string; avgMs: number; samples: number }[] = [];
  const allNetworkLatencies: number[] = [];
  
  for (const url of BASELINE_URLS) {
    process.stdout.write(`  Network to ${new URL(url).hostname}... `);
    const latencies = await measureNetworkLatency(url, 10);
    allNetworkLatencies.push(...latencies);
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    urlLatencies.push({ url, avgMs: avg, samples: latencies.length });
    console.log(`avg ${avg.toFixed(0)}ms (${latencies.length} samples)`);
  }
  
  return {
    networkLatency: computeLatencyStats(allNetworkLatencies),
    redisLatency: redisStats,
    urlLatencies,
  };
}

function computeLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { min: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  return {
    min: Math.min(...latencies),
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: Math.max(...latencies),
  };
}

// ============================================================================
// Real Firecrawl API Operations
// ============================================================================

async function scrapeUrl(client: AxiosInstance, url: string): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const start = performance.now();
  try {
    await client.post("/v1/scrape", { url, formats: ["markdown"] });
    return { success: true, durationMs: performance.now() - start };
  } catch (e: any) {
    return { 
      success: false, 
      durationMs: performance.now() - start,
      error: e.response?.data?.error || e.message 
    };
  }
}

async function batchScrape(client: AxiosInstance, urls: string[]): Promise<{ success: boolean; durationMs: number; jobId?: string; error?: string }> {
  const start = performance.now();
  try {
    const res = await client.post("/v1/batch/scrape", { urls, formats: ["markdown"] });
    return { success: true, durationMs: performance.now() - start, jobId: res.data.id };
  } catch (e: any) {
    return { 
      success: false, 
      durationMs: performance.now() - start,
      error: e.response?.data?.error || e.message 
    };
  }
}

async function startCrawl(client: AxiosInstance, url: string, limit: number): Promise<{ success: boolean; durationMs: number; jobId?: string; error?: string }> {
  const start = performance.now();
  try {
    const res = await client.post("/v1/crawl", { url, limit, scrapeOptions: { formats: ["markdown"] } });
    return { success: true, durationMs: performance.now() - start, jobId: res.data.id };
  } catch (e: any) {
    return { 
      success: false, 
      durationMs: performance.now() - start,
      error: e.response?.data?.error || e.message 
    };
  }
}

async function getCrawlStatus(client: AxiosInstance, jobId: string): Promise<{ success: boolean; durationMs: number; status?: string; error?: string }> {
  const start = performance.now();
  try {
    const res = await client.get(`/v1/crawl/${jobId}`);
    return { success: true, durationMs: performance.now() - start, status: res.data.status };
  } catch (e: any) {
    return { 
      success: false, 
      durationMs: performance.now() - start,
      error: e.response?.data?.error || e.message 
    };
  }
}

async function mapUrl(client: AxiosInstance, url: string): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const start = performance.now();
  try {
    await client.post("/v1/map", { url });
    return { success: true, durationMs: performance.now() - start };
  } catch (e: any) {
    return { 
      success: false, 
      durationMs: performance.now() - start,
      error: e.response?.data?.error || e.message 
    };
  }
}

// ============================================================================
// Benchmark Runner
// ============================================================================

async function runBenchmark(
  name: string,
  iterations: number,
  runs: number,
  operation: (i: number) => Promise<{ success: boolean; durationMs: number; error?: string }>
): Promise<BenchmarkResult> {
  const allLatencies: number[] = [];
  const allOps: number[] = [];
  const errors: string[] = [];
  let totalSuccess = 0;
  let totalAttempts = 0;

  for (let run = 0; run < runs; run++) {
    const latencies: number[] = [];
    let runSuccess = 0;
    
    const startTime = performance.now();
    
    // Run operations with concurrency limit
    const semaphore = { count: 0 };
    const promises: Promise<void>[] = [];
    
    for (let i = 0; i < iterations; i++) {
      while (semaphore.count >= CONFIG.concurrency) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      semaphore.count++;
      promises.push(
        operation(i + run * iterations).then(result => {
          latencies.push(result.durationMs);
          if (result.success) {
            runSuccess++;
          } else if (result.error && !errors.includes(result.error)) {
            errors.push(result.error);
          }
          semaphore.count--;
        })
      );
    }
    
    await Promise.all(promises);
    
    const durationMs = performance.now() - startTime;
    const ops = Math.round((iterations / durationMs) * 1000);
    
    allOps.push(ops);
    allLatencies.push(...latencies);
    totalSuccess += runSuccess;
    totalAttempts += iterations;
  }

  return {
    name,
    iterations,
    runs,
    avgOpsPerSecond: Math.round(allOps.reduce((a, b) => a + b, 0) / runs),
    opsPerSecondStdDev: Math.round(stdDev(allOps)),
    latency: {
      min: allLatencies.length ? Math.min(...allLatencies) : 0,
      avg: allLatencies.length ? allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length : 0,
      p50: percentile(allLatencies, 50),
      p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99),
      max: allLatencies.length ? Math.max(...allLatencies) : 0,
    },
    successRate: totalAttempts > 0 ? (totalSuccess / totalAttempts) * 100 : 0,
    errors: errors.slice(0, 5), // Keep first 5 unique errors
  };
}

async function getMemoryUsage(client: GlideClient): Promise<number> {
  try {
    const memInfo = await client.info([InfoOptions.Memory]);
    const memMatch = memInfo.match(/used_memory:(\d+)/);
    return memMatch ? parseInt(memMatch[1]) / 1024 / 1024 : 0;
  } catch {
    return 0;
  }
}

function printResults(results: BenchmarkResult[], label: string) {
  console.log("\n" + "═".repeat(100));
  console.log(`  FIRECRAWL NATIVE BENCHMARK RESULTS (${label.toUpperCase()})`);
  console.log("═".repeat(100));
  
  console.log("\n┌────────────────────────┬─────────────────────┬─────────────────┬─────────────────┬──────────────┐");
  console.log("│ Operation              │ Throughput (±σ)     │ p99 Latency     │ Avg Latency     │ Success Rate │");
  console.log("├────────────────────────┼─────────────────────┼─────────────────┼─────────────────┼──────────────┤");
  
  for (const r of results) {
    const throughput = `${r.avgOpsPerSecond.toLocaleString()} ±${r.opsPerSecondStdDev}`;
    console.log(
      `│ ${r.name.padEnd(22)} │ ${throughput.padStart(19)} │ ${(r.latency.p99.toFixed(0) + " ms").padStart(15)} │ ${(r.latency.avg.toFixed(0) + " ms").padStart(15)} │ ${(r.successRate.toFixed(1) + "%").padStart(12)} │`
    );
  }
  console.log("└────────────────────────┴─────────────────────┴─────────────────┴─────────────────┴──────────────┘");
}

async function runSingleSuite(
  apiClient: AxiosInstance,
  cacheClient: GlideClient,
  suiteNum: number
): Promise<{ results: BenchmarkResult[]; memoryPeakMB: number }> {
  console.log(`\n── Suite Run ${suiteNum}/${CONFIG.suiteRuns} ──`);
  
  const results: BenchmarkResult[] = [];
  let memoryPeakMB = 0;
  
  // 1. Single scrape operations
  process.stdout.write("  scrape (single URL)... ");
  const r1 = await runBenchmark("scrape", CONFIG.scrapeIterations, CONFIG.runs,
    (i) => scrapeUrl(apiClient, TEST_URLS[i % TEST_URLS.length]));
  console.log(`${r1.avgOpsPerSecond} ops/sec (${r1.successRate.toFixed(0)}% success)`);
  results.push(r1);
  memoryPeakMB = Math.max(memoryPeakMB, await getMemoryUsage(cacheClient));
  
  // 2. Batch scrape (start job)
  process.stdout.write("  batchScrape (start)... ");
  const batchUrls = Array.from({ length: CONFIG.batchSize }, (_, i) => TEST_URLS[i % TEST_URLS.length]);
  const r2 = await runBenchmark("batchScrape", Math.floor(CONFIG.scrapeIterations / 5), CONFIG.runs,
    () => batchScrape(apiClient, batchUrls));
  console.log(`${r2.avgOpsPerSecond} ops/sec (${r2.successRate.toFixed(0)}% success)`);
  results.push(r2);
  memoryPeakMB = Math.max(memoryPeakMB, await getMemoryUsage(cacheClient));
  
  // 3. Crawl (start job)
  process.stdout.write("  crawl (start)... ");
  const r3 = await runBenchmark("crawl", Math.floor(CONFIG.scrapeIterations / 10), CONFIG.runs,
    () => startCrawl(apiClient, TEST_URLS[0], CONFIG.crawlLimit));
  console.log(`${r3.avgOpsPerSecond} ops/sec (${r3.successRate.toFixed(0)}% success)`);
  results.push(r3);
  memoryPeakMB = Math.max(memoryPeakMB, await getMemoryUsage(cacheClient));
  
  // 4. Map operation
  process.stdout.write("  map... ");
  const r4 = await runBenchmark("map", Math.floor(CONFIG.scrapeIterations / 2), CONFIG.runs,
    () => mapUrl(apiClient, TEST_URLS[0]));
  console.log(`${r4.avgOpsPerSecond} ops/sec (${r4.successRate.toFixed(0)}% success)`);
  results.push(r4);
  memoryPeakMB = Math.max(memoryPeakMB, await getMemoryUsage(cacheClient));
  
  // 5. Mixed workload (simulates real usage)
  process.stdout.write("  mixedWorkload... ");
  const r5 = await runBenchmark("mixedWorkload", CONFIG.scrapeIterations, CONFIG.runs,
    async (i) => {
      const op = i % 4;
      switch (op) {
        case 0: return scrapeUrl(apiClient, TEST_URLS[i % TEST_URLS.length]);
        case 1: return mapUrl(apiClient, TEST_URLS[i % TEST_URLS.length]);
        case 2: return batchScrape(apiClient, [TEST_URLS[i % TEST_URLS.length]]);
        default: return scrapeUrl(apiClient, TEST_URLS[i % TEST_URLS.length]);
      }
    });
  console.log(`${r5.avgOpsPerSecond} ops/sec (${r5.successRate.toFixed(0)}% success)`);
  results.push(r5);
  
  return { results, memoryPeakMB };
}

function aggregateResults(allSuiteResults: BenchmarkResult[][]): BenchmarkResult[] {
  const operationNames = allSuiteResults[0].map(r => r.name);
  
  return operationNames.map(name => {
    const resultsForOp = allSuiteResults.map(suite => suite.find(r => r.name === name)!);
    const allOps = resultsForOp.map(r => r.avgOpsPerSecond);
    const allLatencies = resultsForOp.flatMap(r => [r.latency.avg]); // Use avg latencies from each run
    const allSuccessRates = resultsForOp.map(r => r.successRate);
    const allErrors = resultsForOp.flatMap(r => r.errors);
    
    // Aggregate latency stats by averaging
    const avgLatency = (field: keyof LatencyStats) => 
      resultsForOp.reduce((sum, r) => sum + r.latency[field], 0) / resultsForOp.length;
    
    return {
      name,
      iterations: resultsForOp[0].iterations * CONFIG.suiteRuns,
      runs: resultsForOp[0].runs * CONFIG.suiteRuns,
      avgOpsPerSecond: Math.round(allOps.reduce((a, b) => a + b, 0) / allOps.length),
      opsPerSecondStdDev: Math.round(stdDev(allOps)),
      latency: {
        min: Math.min(...resultsForOp.map(r => r.latency.min)),
        avg: avgLatency('avg'),
        p50: avgLatency('p50'),
        p95: avgLatency('p95'),
        p99: avgLatency('p99'),
        max: Math.max(...resultsForOp.map(r => r.latency.max)),
      },
      successRate: allSuccessRates.reduce((a, b) => a + b, 0) / allSuccessRates.length,
      errors: [...new Set(allErrors)].slice(0, 5),
    };
  });
}

async function main() {
  if (process.argv.includes("--compare")) {
    await compareResults();
    return;
  }

  console.log(`\n🔥 Firecrawl Native Benchmark (${CONFIG.label.toUpperCase()})`);
  console.log("═".repeat(60));
  console.log(`API: ${CONFIG.apiUrl}`);
  console.log(`Test URLs: ${USE_LOCAL_PAGES ? "local (nginx)" : "external"}`);
  console.log(`Scrape iterations: ${CONFIG.scrapeIterations} | Batch size: ${CONFIG.batchSize} | Crawl limit: ${CONFIG.crawlLimit}`);
  console.log(`Concurrency: ${CONFIG.concurrency} | Runs per op: ${CONFIG.runs} | Suite runs: ${CONFIG.suiteRuns}`);
  
  const apiClient = createApiClient();
  const cacheClient = await GlideClient.createClient({
    addresses: [{ host: CONFIG.redisHost, port: CONFIG.redisPort }],
  });
  
  // Verify API is reachable
  try {
    await apiClient.get("/");
    console.log(`✓ Firecrawl API connected`);
  } catch (e: any) {
    console.error(`✗ Firecrawl API not reachable at ${CONFIG.apiUrl}`);
    console.error(`  Make sure Firecrawl is running. Error: ${e.message}`);
    process.exit(1);
  }
  
  // Get server info
  let serverInfo = "unknown";
  try {
    const info = await cacheClient.info([InfoOptions.Server]);
    const valkeyMatch = info.match(/valkey_version:([^\r\n]+)/);
    const redisMatch = info.match(/redis_version:([^\r\n]+)/);
    serverInfo = valkeyMatch ? `valkey_version: ${valkeyMatch[1]}` : redisMatch ? `redis_version: ${redisMatch[1]}` : "unknown";
    console.log(`  ${serverInfo}`);
  } catch {
    console.log("  (Could not get Redis/Valkey version)");
  }
  
  // Measure baselines first
  const baselines = await measureBaselines(cacheClient);
  
  console.log(`\nRunning ${CONFIG.suiteRuns} benchmark suite(s)...`);
  
  // Run multiple suite iterations
  const allSuiteResults: BenchmarkResult[][] = [];
  let memoryPeakMB = 0;
  
  for (let i = 1; i <= CONFIG.suiteRuns; i++) {
    const { results, memoryPeakMB: suitePeak } = await runSingleSuite(apiClient, cacheClient, i);
    allSuiteResults.push(results);
    memoryPeakMB = Math.max(memoryPeakMB, suitePeak);
  }
  
  // Aggregate results across all suite runs
  const results = aggregateResults(allSuiteResults);
  
  const memoryFinalMB = await getMemoryUsage(cacheClient);
  
  printResults(results, CONFIG.label);
  
  // Print baseline summary
  console.log(`\n📡 Baselines:`);
  console.log(`   Redis/Valkey PING: avg ${baselines.redisLatency.avg.toFixed(2)}ms, p99 ${baselines.redisLatency.p99.toFixed(2)}ms`);
  console.log(`   Network latency:   avg ${baselines.networkLatency.avg.toFixed(0)}ms, p99 ${baselines.networkLatency.p99.toFixed(0)}ms`);
  
  console.log(`\n📊 Memory: Peak ${memoryPeakMB.toFixed(2)} MB, Final ${memoryFinalMB.toFixed(2)} MB`);
  
  // Print any errors encountered
  const allErrors = results.flatMap(r => r.errors).filter((v, i, a) => a.indexOf(v) === i);
  if (allErrors.length > 0) {
    console.log(`\n⚠️  Errors encountered:`);
    allErrors.slice(0, 5).forEach(e => console.log(`   - ${e}`));
  }
  
  // Save results
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  
  // Exclude sensitive data (apiKey) from saved results
  const { apiKey, ...safeConfig } = CONFIG;
  const suite: ScaleBenchmarkSuite = {
    label: CONFIG.label,
    timestamp: new Date().toISOString(),
    config: safeConfig as typeof CONFIG,
    serverInfo,
    baselines,
    results,
    memoryPeakMB,
    memoryFinalMB,
  };
  
  const filename = path.join(RESULTS_DIR, `${CONFIG.label}-scale.json`);
  fs.writeFileSync(filename, JSON.stringify(suite, null, 2));
  console.log(`\n💾 Results saved to ${filename}`);
  
  await cacheClient.close();
}

async function compareResults() {
  console.log("\n🔥 Firecrawl Native Benchmark Comparison");
  console.log("═".repeat(100));
  
  const redisFile = path.join(RESULTS_DIR, "redis-scale.json");
  const valkeyFile = path.join(RESULTS_DIR, "valkey-scale.json");
  
  if (!fs.existsSync(redisFile) || !fs.existsSync(valkeyFile)) {
    console.error("Missing benchmark files. Run:");
    console.error("  LABEL=redis pnpm run benchmark:scale");
    console.error("  LABEL=valkey pnpm run benchmark:scale");
    process.exit(1);
  }
  
  const redis: ScaleBenchmarkSuite = JSON.parse(fs.readFileSync(redisFile, "utf-8"));
  const valkey: ScaleBenchmarkSuite = JSON.parse(fs.readFileSync(valkeyFile, "utf-8"));
  
  console.log(`Redis:  ${redis.serverInfo}`);
  console.log(`Valkey: ${valkey.serverInfo}`);
  
  console.log("\n┌────────────────────────┬─────────────────────┬─────────────────────┬─────────────────┐");
  console.log("│ Operation              │ Redis (ops/sec)     │ Valkey (ops/sec)    │ Difference      │");
  console.log("├────────────────────────┼─────────────────────┼─────────────────────┼─────────────────┤");
  
  for (const rResult of redis.results) {
    const vResult = valkey.results.find(v => v.name === rResult.name);
    if (!vResult) continue;
    
    const rStr = `${rResult.avgOpsPerSecond} ±${rResult.opsPerSecondStdDev}`;
    const vStr = `${vResult.avgOpsPerSecond} ±${vResult.opsPerSecondStdDev}`;
    
    const diff = ((vResult.avgOpsPerSecond - rResult.avgOpsPerSecond) / rResult.avgOpsPerSecond) * 100;
    const diffStr = diff >= 0 ? `+${diff.toFixed(1)}% Valkey` : `+${Math.abs(diff).toFixed(1)}% Redis`;
    
    console.log(
      `│ ${rResult.name.padEnd(22)} │ ${rStr.padStart(19)} │ ${vStr.padStart(19)} │ ${diffStr.padStart(15)} │`
    );
  }
  console.log("└────────────────────────┴─────────────────────┴─────────────────────┴─────────────────┘");
  
  console.log("\n📊 Memory:");
  console.log(`   Redis:  Peak ${redis.memoryPeakMB.toFixed(2)} MB, Final ${redis.memoryFinalMB.toFixed(2)} MB`);
  console.log(`   Valkey: Peak ${valkey.memoryPeakMB.toFixed(2)} MB, Final ${valkey.memoryFinalMB.toFixed(2)} MB`);
  
  // Print baselines if available
  if (redis.baselines && valkey.baselines) {
    console.log("\n📡 Baselines (context for variance):");
    console.log(`   Redis run:`);
    console.log(`     - Redis PING:     avg ${redis.baselines.redisLatency.avg.toFixed(2)}ms, p99 ${redis.baselines.redisLatency.p99.toFixed(2)}ms`);
    console.log(`     - Network:        avg ${redis.baselines.networkLatency.avg.toFixed(0)}ms, p99 ${redis.baselines.networkLatency.p99.toFixed(0)}ms`);
    console.log(`   Valkey run:`);
    console.log(`     - Valkey PING:    avg ${valkey.baselines.redisLatency.avg.toFixed(2)}ms, p99 ${valkey.baselines.redisLatency.p99.toFixed(2)}ms`);
    console.log(`     - Network:        avg ${valkey.baselines.networkLatency.avg.toFixed(0)}ms, p99 ${valkey.baselines.networkLatency.p99.toFixed(0)}ms`);
  }
}

main().catch(console.error);
