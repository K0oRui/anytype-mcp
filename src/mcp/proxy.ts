import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { OpenAPIV3 } from "openapi-types";
import { HttpClient, HttpClientError } from "../client/http-client";
import { OpenAPIToMCPConverter } from "../openapi/parser";
import { determineBaseUrl } from "../utils/base-url";
import { buildOperationIndex, respellResponse, servesJsonEnvelope, type OperationIndex } from "./see-also";
import { compactWriteResponse } from "./write-response";

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject;
  put?: OpenAPIV3.OperationObject;
  post?: OpenAPIV3.OperationObject;
  delete?: OpenAPIV3.OperationObject;
  patch?: OpenAPIV3.OperationObject;
};

type NewToolDefinition = {
  methods: Array<{
    name: string;
    description: string;
    inputSchema: IJsonSchema & { type: "object" };
    outputSchema?: IJsonSchema;
  }>;
};

export class MCPProxy {
  private server: Server;
  private httpClient: HttpClient;
  private tools: Record<string, NewToolDefinition>;
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>;
  // advertised tool name → its required arguments. A required path argument
  // left out by the caller is otherwise substituted into the route as the
  // literal string "undefined", and the API answers a 404 about a resource
  // named "undefined" instead of naming the argument that is missing.
  private requiredArguments: Map<string, string[]>;
  // operationId → this server's tool, for re-spelling the server's typed
  // repair hints (see_also) in the tool vocabulary
  private operationIndex: OperationIndex;
  private components: OpenAPIV3.ComponentsObject | undefined;
  // Tools that advertise an outputSchema. The protocol requires a result that
  // conforms to a declared schema, so these also return structuredContent.
  private toolsWithOutputSchema: Set<string>;

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
    // Validate the advertised surface before initializing an HTTP client.
    const converter = new OpenAPIToMCPConverter(openApiSpec);
    const { tools, openApiLookup } = converter.convertToMCPTools();
    this.tools = tools;
    this.openApiLookup = openApiLookup;
    this.requiredArguments = new Map(
      Object.entries(tools).flatMap(([toolName, def]) =>
        def.methods
          .filter((method) => method.inputSchema.required?.length)
          .map((method) => [`${toolName}-${method.name}`, method.inputSchema.required!] as const),
      ),
    );
    this.toolsWithOutputSchema = new Set(
      Object.entries(tools).flatMap(([toolName, def]) =>
        def.methods
          // the protocol only accepts an object output schema
          .filter((method) => method.outputSchema?.type === "object")
          .map((method) => `${toolName}-${method.name}`),
      ),
    );
    this.operationIndex = buildOperationIndex(openApiLookup, openApiSpec.components);
    this.components = openApiSpec.components;
    const baseUrl = determineBaseUrl(openApiSpec);
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: this.parseHeadersFromEnv(),
      },
      openApiSpec,
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [];

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach((method) => {
          const toolNameWithMethod = `${toolName}-${method.name}`;
          tools.push({
            name: toolNameWithMethod,
            description: method.description,
            inputSchema: method.inputSchema as Tool["inputSchema"],
            ...(method.outputSchema?.type === "object"
              ? { outputSchema: method.outputSchema as Tool["outputSchema"] }
              : {}),
          });
        });
      });

      return { tools };
    });

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: params } = request.params;

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name);
      if (!operation) {
        throw new Error(`Method ${name} not found`);
      }

      const missing = (this.requiredArguments.get(name) ?? []).filter((argument) => params?.[argument] === undefined);
      if (missing.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "invalid_arguments",
                message: `${missing.map((argument) => `\`${argument}\``).join(", ")} ${
                  missing.length === 1 ? "is" : "are"
                } required`,
              }),
            },
          ],
        };
      }

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(
          operation,
          params,
          ...(extra?.signal ? [{ signal: extra.signal }] : []),
        );

        const metadata = {
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag") } : {}),
          ...(response.requestKey ? { request_key: response.requestKey } : {}),
        };
        const shaped = compactWriteResponse(
          operation,
          servesJsonEnvelope(operation, response.status, this.components)
            ? respellResponse(response.data, this.operationIndex, operation.operationId)
            : response.data,
        );
        // A declared outputSchema obliges the result to carry structured
        // content that conforms to it. The generated schemas describe objects,
        // so an object response is passed through as structuredContent; any
        // other shape stays in the text block.
        const structured =
          this.toolsWithOutputSchema.has(name) && shaped !== null && typeof shaped === "object" && !Array.isArray(shaped)
            ? (shaped as Record<string, unknown>)
            : undefined;
        return {
          ...(structured ? { structuredContent: structured } : {}),
          content: [
            {
              type: "text",
              // typed repair hints are re-spelled in the tool vocabulary
              // first; a download's body is content, not an envelope
              text: JSON.stringify(shaped),
            },
            ...(Object.keys(metadata).length
              ? [{ type: "text", text: JSON.stringify({ request_metadata: metadata }) }]
              : []),
          ],
        };
      } catch (error) {
        if (error instanceof HttpClientError) {
          const data = respellResponse(error.data ?? {}, this.operationIndex, operation.operationId);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...(typeof data === "object" && !Array.isArray(data) ? data : { data }),
                  ...(error.status ? { status: error.status } : {}),
                  ...(error.requestKey ? { request_key: error.requestKey } : {}),
                }),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "tool_error",
                message: error instanceof Error ? error.message : "Tool call failed",
              }),
            },
          ],
        };
      }
    });
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null;
  }

  private parseHeadersFromEnv(): Record<string, string> {
    const headersJson = process.env.OPENAPI_MCP_HEADERS;
    if (!headersJson) {
      return {};
    }

    try {
      const headers = JSON.parse(headersJson);
      if (typeof headers !== "object" || headers === null) {
        console.warn("OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:", typeof headers);
        return {};
      }
      return headers;
    } catch (error) {
      console.warn("Failed to parse OPENAPI_MCP_HEADERS environment variable:", error);
      return {};
    }
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport);
  }
}
