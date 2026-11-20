import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { REPLIT_MCP_URL } from "./oauth";

export type ReplitToolResult = { content: Array<{ type: string; text?: string; [key: string]: unknown }>; structuredContent?: Record<string, unknown>; isError?: boolean; [key: string]: unknown };
export type CreateAppInput = { appDescription: string; app_stack: "react_website"; userSpecifiedAppName?: string };
export type PreviewLookupInput = { replId: string; gitSha: string; timestamp: string; enableHelium?: boolean };
export type StartPreviewInput = { replId?: string; previewUrl: string; riverToken: string; riverGurl: string };

/** Separate seam preserves existing publication mocks; caller supplies observed checkpoint metadata. */
export interface ReplitArtifactPort {
  listAppFiles(replId: string, path?: string): Promise<ReplitToolResult>;
  readAppFile(replId: string, path: string): Promise<ReplitToolResult>;
  getPreviewUrl(input: PreviewLookupInput): Promise<ReplitToolResult>;
  startAppPreview(input: StartPreviewInput): Promise<ReplitToolResult>;
}

export interface ReplitMcpPort {
  discoverTools(): Promise<Tool[]>;
  createApp(input: CreateAppInput): Promise<ReplitToolResult>;
  updateApp(replId: string, changeDescription: string): Promise<ReplitToolResult>;
  askBuildReadiness(replId: string): Promise<ReplitToolResult>;
  publishApp(replId: string): Promise<ReplitToolResult>;
  getPublishStatus(replId: string): Promise<ReplitToolResult>;
  close(): Promise<void>;
}

const allowedTools = new Set(["create_app_from_prompt", "update_app_using_prompt", "ask_question", "publish_app", "get_publish_status", "list_apps", "search_apps", "resolve_app_by_name", "list_app_files", "read_app_file", "replit_widget_get_preview_url", "replit_widget_start_app_preview"]);

function sourcePath(value: string) {
  if (!value || value.length > 1000 || value.startsWith("/") || value.includes("\\") || value.split("/").some(segment => !segment || segment.startsWith(".") || ["node_modules", "credentials", "secrets"].includes(segment.toLowerCase()))) {
    throw new Error("Replit artifact path must be a relative source path without hidden/private directories.");
  }
  if (/(?:^|\/)(?:[^/]*\.)?(?:env|pem|key|p12|pfx|sqlite|db)(?:\.|$)|(?:^|\/)(?:credentials|secrets|tokens?)(?:\.|$)/i.test(value)) {
    throw new Error("Private credential artifacts cannot be read through the review adapter.");
  }
  return value;
}

/** Validates against live-discovered schemas, never only an LLM-authored payload. */
export class ReplitMcpClient implements ReplitMcpPort, ReplitArtifactPort {
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly tools = new Map<string, Tool>();
  private constructor(private readonly client: Pick<Client, "listTools" | "callTool" | "close">) {}
  static async connect(provider: OAuthClientProvider) {
    const client = new Client({ name: "shopcall", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(REPLIT_MCP_URL), { authProvider: provider });
    try { await client.connect(transport, { timeout: 30_000 }); }
    catch { await client.close().catch(() => {}); throw new Error("Replit MCP connection failed or requires app-owned OAuth reconnection."); }
    return new ReplitMcpClient(client);
  }
  /** Dependency injection for deterministic contract tests; no provider success implied. */
  static fromClient(client: Pick<Client, "listTools" | "callTool" | "close">) { return new ReplitMcpClient(client); }
  async discoverTools() {
    const discovered: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      discovered.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Replit tool discovery returned a repeated cursor.");
      if (cursor) seen.add(cursor);
      if (seen.size > 100) throw new Error("Replit tool discovery exceeded page limit.");
    } while (cursor);
    this.tools.clear();
    for (const tool of discovered) this.tools.set(tool.name, tool);
    return discovered;
  }
  async call(name: string, args: Record<string, unknown>): Promise<ReplitToolResult> {
    if (!allowedTools.has(name)) throw new Error("Replit tool is outside Shopcall's integration allowlist.");
    if (!this.tools.size) await this.discoverTools();
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Replit capability unavailable: ${name}.`);
    const result = this.validator.getValidator(tool.inputSchema as JsonSchemaType)(args);
    if (!result.valid) throw new Error(`Replit arguments do not match discovered schema for ${name}.`);
    let response: ReplitToolResult;
    try { response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000, maxTotalTimeout: 180_000 }) as ReplitToolResult; }
    catch { throw new Error(`Replit ${name} request failed; reconcile remote outcome before retrying mutations.`); }
    if (response.isError) throw new Error(`Replit ${name} returned a provider error.`);
    return response;
  }
  createApp(input: CreateAppInput) { return this.call("create_app_from_prompt", input); }
  updateApp(replId: string, changeDescription: string) { return this.call("update_app_using_prompt", { replId, changeDescription }); }
  askBuildReadiness(replId: string) {
    // A prose/LLM answer is useful for diagnostics only, not a build-success receipt.
    return this.call("ask_question", { replId, question: "Report current build state, whether compilation/tests completed, and any actual machine-readable build receipt or runtime verification URL. Do not infer completion from an accepted generation request." });
  }
  publishApp(replId: string) { return this.call("publish_app", { replId }); }
  getPublishStatus(replId: string) { return this.call("get_publish_status", { replId }); }
  listAppFiles(replId: string, path?: string) { return this.call("list_app_files", path === undefined ? { replId } : { replId, path: sourcePath(path.replace(/\/$/, "")) }); }
  readAppFile(replId: string, path: string) { return this.call("read_app_file", { replId, path: sourcePath(path) }); }
  getPreviewUrl(input: PreviewLookupInput) { return this.call("replit_widget_get_preview_url", input); }
  // River credentials must come from a documented/observed provider flow, never authnToken guessing.
  // Arguments and preview tokens must never be logged or persisted into public evidence.
  startAppPreview(input: StartPreviewInput) { return this.call("replit_widget_start_app_preview", input); }
  close() { return this.client.close(); }
}
