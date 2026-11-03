// Adapted from copied assets/AssetAccess.readMcpAppHtml and mcpApps/McpAppSnapshot.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { injectMcpAppCookieBootstrap, injectMcpAppThemeBootstrap, MCP_APP_MAX_HTML_BYTES, type McpAppReference } from "@t3tools/shared/mcpApp";
import type { McpAppMetadata } from "@agent-workspace/contracts/mcp-apps";
import { DurableError } from "../durable/errors.ts";
import { readRecord, writeRecord } from "../durable/store.ts";
import { providerAttachmentsDirectory, resolveAttachmentPathById } from "../providers/t3code/upstream-services/attachments.ts";

const ASSETS = "mcp-app-private-assets-v1";
const LIMIT = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
type Asset = { threadId: string; reference: McpAppReference; size: number; sha256: string };
export function registerMcpAppAsset(threadId: string, reference: McpAppReference, html: string): void {
  writeRecord<Asset>(ASSETS, reference.attachmentId, { threadId, reference,
    size: Buffer.byteLength(html, "utf8"), sha256: createHash("sha256").update(html, "utf8").digest("hex") });
}

export async function readMcpAppHtml(app: McpAppMetadata): Promise<string> {
  const asset = readRecord<Asset>(ASSETS, app.attachmentId);
  const { producing: _producing, ...reference } = app;
  if (!asset || asset.threadId !== app.producing.threadId || JSON.stringify(asset.reference) !== JSON.stringify(reference))
    throw new DurableError(404, "mcp_app_asset_not_found", "This App has no matching registered private HTML asset.");
  const file = resolveAttachmentPathById({ attachmentsDir: providerAttachmentsDirectory(), attachmentId: app.attachmentId });
  if (!file) throw new DurableError(404, "mcp_app_asset_not_found", "The registered App document is missing or changed.");
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await descriptor.stat();
    if (!stat.isFile() || stat.size !== asset.size || stat.size > LIMIT)
      throw new DurableError(413, "mcp_app_asset_too_large", "The registered App document is changed or too large.");
    // Bound allocation and every read, even if the file grows after the initial stat.
    const bytes = Buffer.alloc(Math.min(LIMIT + 1, stat.size + 1));
    let size = 0;
    while (size < bytes.length) {
      const chunk = await descriptor.read(bytes, size, bytes.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    const body = bytes.subarray(0, size);
    if (size !== asset.size || createHash("sha256").update(body).digest("hex") !== asset.sha256)
      throw new DurableError(409, "mcp_app_asset_changed", "The private App document changed after capture.");
    return injectMcpAppCookieBootstrap(injectMcpAppThemeBootstrap(body.toString("utf8")));
  } finally { await descriptor.close(); }
}
