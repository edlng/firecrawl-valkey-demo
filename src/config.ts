import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const config = {
  firecrawl: {
    apiUrl: process.env.FIRECRAWL_API_URL || "http://localhost:3002",
    apiKey: process.env.FIRECRAWL_API_KEY || "fc-test-key",
  },
  valkey: {
    host: process.env.VALKEY_HOST || "localhost",
    port: parseInt(process.env.VALKEY_PORT || "6379", 10),
  },
  rateLimits: {
    scrape: parseInt(process.env.RATE_LIMIT_SCRAPE || "10", 10),
    crawl: parseInt(process.env.RATE_LIMIT_CRAWL || "5", 10),
    batch: parseInt(process.env.RATE_LIMIT_BATCH || "3", 10),
  },
};
