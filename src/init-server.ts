import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { OpenAPIV3 } from "openapi-types";
import { MCPProxy } from "./mcp/proxy";
import { getDefaultSpecUrl } from "./utils/base-url";

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

// A connection-level failure means the local app is not listening yet, often
// because it is still starting alongside the MCP process. Retry those; an
// HTTP status (401, 404, 500) is a real answer and must fail immediately.
const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);
const CONNECT_RETRY_BASE_MS = 250;
const CONNECT_RETRY_MAX_MS = 2000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

function connectTimeoutMs(): number {
  const raw = Number(process.env.ANYTYPE_MCP_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CONNECT_TIMEOUT_MS;
}

async function withConnectRetry<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + connectTimeoutMs();
  let delay = CONNECT_RETRY_BASE_MS;
  let notified = false;
  for (;;) {
    try {
      return await attempt();
    } catch (error: any) {
      if (!CONNECT_ERROR_CODES.has(error?.code) || Date.now() >= deadline) throw error;
      if (!notified) {
        console.error("Anytype API not reachable yet; waiting for it to start...");
        notified = true;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, CONNECT_RETRY_MAX_MS);
    }
  }
}

export async function loadOpenApiSpec(specPath?: string): Promise<OpenAPIV3.Document> {
  const fallbackSpec = specPath ? undefined : getDefaultSpecUrl();
  const finalSpec = specPath || new URL("/v2/docs/openapi.json", fallbackSpec).href;
  let rawSpec: string;

  if (finalSpec.startsWith("http://") || finalSpec.startsWith("https://")) {
    try {
      const response = await withConnectRetry(() => fetchSpec(finalSpec, fallbackSpec));
      rawSpec = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    } catch (error: any) {
      if (error.code === "ECONNREFUSED") {
        console.error("Can't connect to API. Please ensure Anytype is running and reachable.");
        return process.exit(1);
      }
      console.error("Failed to fetch OpenAPI specification from URL:", error.message);
      return process.exit(1);
    }
  } else {
    const filePath = path.resolve(process.cwd(), finalSpec);
    try {
      rawSpec = fs.readFileSync(filePath, "utf-8");
    } catch (error: any) {
      console.error("Failed to read OpenAPI specification file:", error.message || String(error));
      return process.exit(1);
    }
  }

  try {
    return JSON.parse(rawSpec) as OpenAPIV3.Document;
  } catch (error: any) {
    console.error("Failed to parse OpenAPI specification:", error.message);
    return process.exit(1);
  }
}

async function fetchSpec(url: string, fallbackUrl?: string) {
  try {
    return await axios.get(url);
  } catch (error: any) {
    // Older apps only serve the legacy spec at /docs/openapi.json. An explicit
    // URL, authorization error, server failure, or invalid document must not
    // silently select a different API version.
    if (fallbackUrl && [404, 410].includes(error.response?.status)) {
      console.error("v2 OpenAPI endpoint unavailable; falling back to /docs/openapi.json.");
      return await axios.get(fallbackUrl);
    }
    throw error;
  }
}

export async function initProxy(specPath?: string) {
  console.error("Initializing Anytype MCP Server...");
  const openApiSpec = await loadOpenApiSpec(specPath);
  const proxy = new MCPProxy("Anytype API", openApiSpec);

  await proxy.connect(new StdioServerTransport());
  console.error("Anytype MCP Server running on stdio");
}
