import { z } from "zod";
import { usageProviderKindSchema, usageSummarySchema } from "@agent-workspace/contracts/usage";
import { agentText } from "../i18n";
import { isUsageContractCompatible, type UsageSummaryRead } from "./usage-view-model.ts";

const envelopeSchema = usageSummarySchema.omit({ buckets: true, sources: true }).extend({ buckets: z.array(z.unknown()), sources: z.array(z.unknown()) });
const bucketProviderSchema = z.object({ provider: z.string() });
const sourceProviderSchema = z.object({ fingerprint: z.object({ provider: z.string() }) });

/** Unknown providers are visible omissions, never misclassified as another provider. */
export function decodeUsageSummary(value: unknown): UsageSummaryRead {
  const envelope = envelopeSchema.parse(value);
  if (!isUsageContractCompatible(envelope.contractVersion)) return { ...envelope, buckets: [], sources: [] };
  const unknown = new Set<string>();
  const buckets = envelope.buckets.filter(bucket => {
    const { provider } = bucketProviderSchema.parse(bucket);
    if (usageProviderKindSchema.safeParse(provider).success) return true;
    unknown.add(provider);
    return false;
  });
  const sources = envelope.sources.filter(source => {
    const { fingerprint } = sourceProviderSchema.parse(source);
    if (usageProviderKindSchema.safeParse(fingerprint.provider).success) return true;
    unknown.add(fingerprint.provider);
    return false;
  });
  const summary = usageSummarySchema.parse({ ...envelope, buckets, sources });
  return unknown.size ? { ...summary, compatibilityWarnings: [agentText(`此客户端不支持以下 Provider，其数据未计入：${[...unknown].sort().join("、")}。`, `This client does not support these providers; their data was excluded: ${[...unknown].sort().join(", ")}.`)] } : summary;
}

let revision = 0;
const listeners = new Set<() => void>();
export function usageSettingsRevision(): number { return revision; }
export function subscribeUsageSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Successful mutations invalidate mounted summary readers; conflicts do not. */
export function invalidateUsageSettings(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
