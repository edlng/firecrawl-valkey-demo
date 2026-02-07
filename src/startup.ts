import { execSync } from "child_process";
import path from "path";

const PROJECT_ROOT = path.resolve(__dirname, "..");

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForService(
  name: string,
  url: string,
  maxAttempts = 60,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await checkHealth(url)) {
      console.log(`[Startup] ${name} is ready`);
      return true;
    }
    if (i > 0 && i % 10 === 0) {
      console.log(
        `[Startup] Waiting for ${name}... (attempt ${i}/${maxAttempts})`,
      );
    }
    await sleep(2000);
  }
  return false;
}

export async function startDependencies(
  firecrawlUrl: string,
): Promise<boolean> {
  const skipDocker = process.env.SKIP_DOCKER === "true";

  if (skipDocker) {
    console.log("[Startup] SKIP_DOCKER=true, skipping docker compose");
    return true;
  }

  if (await checkHealth(firecrawlUrl)) {
    console.log("[Startup] Firecrawl API already running");
    return true;
  }

  console.log("[Startup] Starting Firecrawl services via docker compose...");
  console.log("[Startup] This may take a minute on first run...");

  const maxDockerAttempts = 3;
  for (let attempt = 1; attempt <= maxDockerAttempts; attempt++) {
    try {
      execSync("docker compose -f deploy/docker-compose.yaml up -d", {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
      });
      break;
    } catch {
      if (attempt < maxDockerAttempts) {
        console.log(`[Startup] Docker compose attempt ${attempt} failed, retrying in 5s...`);
        await sleep(5000);
      } else {
        console.log("[Startup] Docker compose failed after retries, checking if services come up anyway...");
      }
    }
  }

  console.log("[Startup] Waiting for Firecrawl API to be ready...");
  const ready = await waitForService(
    "Firecrawl API",
    firecrawlUrl,
    90,
  );

  if (!ready) {
    console.error("[Startup] Firecrawl API failed to become healthy");
    console.error("[Startup] Check docker logs: docker compose -f deploy/docker-compose.yaml logs -f");
    return false;
  }

  return true;
}

export function setupShutdownHandler(): void {
  const shutdown = () => {
    console.log("\n[Startup] Shutting down...");

    if (process.env.SKIP_DOCKER !== "true") {
      try {
        console.log("[Startup] Stopping docker services...");
        execSync("docker compose -f deploy/docker-compose.yaml down", {
          cwd: PROJECT_ROOT,
          stdio: "inherit",
        });
      } catch {
        // Ignore errors during shutdown
      }
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
