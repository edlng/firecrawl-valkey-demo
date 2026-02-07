import axios, { AxiosInstance } from "axios";
import { config } from "./config";

export interface ScrapeResult {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

export interface CrawlResult {
  success: boolean;
  id?: string;
  status?: string;
  total?: number;
  completed?: number;
  data?: Array<{
    markdown?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }>;
  error?: string;
}

export interface BatchScrapeResult {
  success: boolean;
  id?: string;
  url?: string;
  error?: string;
}

export interface BatchScrapeStatus {
  success: boolean;
  status?: string;
  total?: number;
  completed?: number;
  data?: Array<{
    markdown?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }>;
  error?: string;
}

export class FirecrawlClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.firecrawl.apiUrl,
      headers: {
        Authorization: `Bearer ${config.firecrawl.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    });
  }

  async scrape(
    url: string,
    options: Record<string, unknown> = {},
  ): Promise<ScrapeResult> {
    const response = await this.client.post("/v1/scrape", { url, ...options });
    return { success: true, data: response.data.data };
  }

  async batchScrape(
    urls: string[],
    options: Record<string, unknown> = {},
  ): Promise<BatchScrapeResult> {
    const response = await this.client.post("/v1/batch/scrape", { urls, ...options });
    return { success: true, id: response.data.id, url: response.data.url };
  }

  async getBatchScrapeStatus(batchId: string): Promise<BatchScrapeStatus> {
    const response = await this.client.get(`/v1/batch/scrape/${batchId}`);
    return { success: true, ...response.data };
  }

  async crawl(
    url: string,
    options: Record<string, unknown> = {},
  ): Promise<CrawlResult> {
    const response = await this.client.post("/v1/crawl", { url, ...options });
    return { success: true, id: response.data.id };
  }

  async getCrawlStatus(crawlId: string): Promise<CrawlResult> {
    const response = await this.client.get(`/v1/crawl/${crawlId}`);
    return { success: true, ...response.data };
  }
}
