import * as fs from "node:fs";
import path from "node:path";
import type { ChatAttachment } from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import {
  providerAttachmentsDirectory,
  registerProviderAttachment,
} from "../../../../../../../apps/server/agent/src/providers/t3code/upstream-services/attachments.ts";

/** A path for bytes the fixture will persist; looking it up never registers an attachment. */
export function claudeFixtureAttachmentPath(root: string, attachment: ChatAttachment): string {
  if (!/^[a-z0-9_-]+$/i.test(attachment.id)) throw new Error("Unsafe Claude fixture attachment id.");
  return path.join(root, attachment.id);
}

/** Model trusted uploads using the actual persisted bytes and PM's production registry. */
export function withClaudeFixtureAttachments(
  runtime: ProviderAdapterV2SessionRuntime,
  root: string,
): ProviderAdapterV2SessionRuntime {
  const admit = (attachments: ReadonlyArray<ChatAttachment>): ReadonlyArray<ChatAttachment> =>
    attachments.map(attachment => {
      if (attachment.type !== "image" && attachment.type !== "file") return attachment;
      const file = claudeFixtureAttachmentPath(root, attachment);
      let sizeBytes: number;
      try { sizeBytes = fs.statSync(file).size; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return attachment;
        throw error;
      }
      const persisted = { ...attachment, sizeBytes };
      registerProviderAttachment(persisted, path.relative(providerAttachmentsDirectory(), file));
      return persisted;
    });
  return {
    ...runtime,
    startTurn: input => Effect.suspend(() => runtime.startTurn({
      ...input,
      message: { ...input.message, attachments: admit(input.message.attachments) },
    })),
    steerTurn: input => Effect.suspend(() => runtime.steerTurn({
      ...input,
      message: { ...input.message, attachments: admit(input.message.attachments) },
    })),
  };
}
