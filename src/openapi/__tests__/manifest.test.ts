import { readFileSync } from "node:fs";
import { URL } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { describe, expect, it } from "vitest";
import { OpenAPIToMCPConverter } from "../parser";

const v1 = JSON.parse(
  readFileSync(new URL("./fixtures/anytype-v1.json", import.meta.url), "utf8"),
) as OpenAPIV3.Document;
const v2 = JSON.parse(
  readFileSync(new URL("./fixtures/anytype-v2.json", import.meta.url), "utf8"),
) as OpenAPIV3.Document;

describe("fixed Anytype tool manifests", () => {
  it.each([
    { version: "v1", spec: v1, count: 49, maxCharacters: 34000 },
    // v2 tools carry each operation's description beside its summary (the
    // server bounds those to 400 characters), and both versions add curated
    // lines for routes the document leaves as a bare summary. v2 measured
    // 86,347 characters with the object administration tools; the ceiling is
    // deliberately a few per cent above, so the next batch has to raise it
    // on purpose rather than grow into it unnoticed.
    { version: "v2", spec: v2, count: 83, maxCharacters: 87000 },
  ])("keeps the $version tool list compact and usable", ({ version, spec, count, maxCharacters }) => {
    const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec as OpenAPIV3.Document).convertToMCPTools();
    const listed = tools.API.methods.map(({ name, description, inputSchema }) => ({
      name: `API-${name}`,
      description,
      inputSchema,
    }));
    expect(listed).toHaveLength(count);
    expect(JSON.stringify({ tools: listed }).length).toBeLessThanOrEqual(maxCharacters);
    expect(new Set(listed.map((tool) => tool.name)).size).toBe(count);
    for (const tool of listed) {
      expect(tool.description).not.toContain("Error Responses:");
      expect(openApiLookup[tool.name].path).toMatch(new RegExp(`^/${version}/`));
      expect(tool.inputSchema).not.toHaveProperty("$defs", {});
      for (const hidden of [
        "Authorization",
        "Anytype-Version",
        "Idempotency-Key",
        "If-Match",
        "Range",
        "If-None-Match",
        "If-Range",
        "Last-Event-ID",
      ]) {
        expect(tool.inputSchema.properties).not.toHaveProperty(hidden);
      }
    }
    const byName = Object.fromEntries(listed.map((tool) => [tool.name, tool]));
    expect(byName).toHaveProperty("API-download-file");
    expect(byName).toHaveProperty("API-upload-file");
    expect(byName).toHaveProperty("API-get-chat-messages");
    expect(byName).not.toHaveProperty("API-chat-message-stream");
    expect(byName).not.toHaveProperty("API-stream-chat-messages");
    expect(byName).not.toHaveProperty("API-create-api-key");
    expect(byName).not.toHaveProperty("API-create-auth-challenge");
    // A route that can only answer 501 must not be advertised
    expect(byName).not.toHaveProperty("API-get-type-schema");
    // A curated description stands in where the document gave only a summary
    for (const tool of listed) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
    }
    expect(byName["API-list-objects"].description).toContain("fields");
    expect(byName["API-list-properties"].description).toContain("properties in a space");
    expect(byName["API-list-members"].description.length).toBeGreaterThan(20);
    if (version === "v2") {
      expect(byName).toHaveProperty("API-auth-whoami");
      expect(byName).toHaveProperty("API-get-op-schema");
      expect(byName["API-create-type"].inputSchema.properties).toHaveProperty("body");
      expect(byName["API-create-type"].inputSchema.properties).toHaveProperty("dry_run");
      expect(byName["API-create-type"].inputSchema.properties).toHaveProperty("create_missing_options");
      expect(byName["API-patch-object"].inputSchema.properties).toHaveProperty("expected_etag");
      expect(byName["API-create-space"].inputSchema.properties).toHaveProperty("request_key");
      expect(byName["API-list-objects"].inputSchema.properties).toHaveProperty("fields");
      // Space administration: the invite/join surface takes its credential from
      // the link, so view-invite wants the file key as an input.
      expect(byName).toHaveProperty("API-create-invite");
      expect(byName).toHaveProperty("API-view-invite");
      expect(byName["API-view-invite"].inputSchema.properties).toHaveProperty("file_key");
      expect(byName["API-create-invite"].inputSchema.properties).toHaveProperty("invite_type");
      expect(byName["API-join-space"].inputSchema.properties).toHaveProperty("invite_file_key");
      expect(byName["API-share-space"].inputSchema.properties).toHaveProperty("dry_run");
      expect(byName["API-change-space-ownership"].inputSchema.properties).toHaveProperty("new_owner_identity");
      // Object administration: the whole-object verbs, the bulk writes and
      // the two typed envelopes the older surface had no route for. The
      // request DTO fields are inlined as tool properties, so the checks below
      // read the members a caller sends.
      for (const tool of [
        "API-duplicate-object",
        "API-set-objects-archived",
        "API-set-objects-type",
        "API-set-objects-properties",
        "API-set-object-layout",
        "API-convert-object",
        "API-set-object-source",
        "API-refresh-object",
        "API-create-object-from-url",
        "API-set-object-icon",
        "API-set-object-cover",
        "API-set-object-items-order",
      ]) {
        expect(byName).toHaveProperty(tool);
      }
      expect(byName["API-set-objects-archived"].inputSchema.properties).toHaveProperty("archived");
      expect(byName["API-set-objects-properties"].inputSchema.properties).toHaveProperty("set");
      expect(byName["API-convert-object"].inputSchema.properties).toHaveProperty("to");
      expect(byName["API-convert-object"].inputSchema.properties).toHaveProperty("source");
      expect(byName["API-create-object-from-url"].inputSchema.properties).toHaveProperty("url");
      expect(byName["API-set-object-icon"].inputSchema.properties).toHaveProperty("format");
      expect(byName["API-set-object-cover"].inputSchema.properties).toHaveProperty("format");
      expect(byName["API-set-object-items-order"].inputSchema.properties).toHaveProperty("ids");
    }
  });
});
