import { z } from "zod";

/** Provenance identifies shipped bytes, never a runtime-loaded or user-invocable claim. */
export type BundledSkill = {
  id: string;
  name: string;
  description: string;
  sourceLabel: "Dovspace";
  sourcePath: string;
  sha256: string;
};
export type BundledSkillsCatalog = { skills: BundledSkill[]; bundleDigest: string };
export type BundledSkillStatus = "not-installed" | "installed" | "update-available" | "conflict" | "unavailable";
export type ProviderBundledSkillsState = {
  providerInstanceId: string;
  bundleDigest: string;
  /** Frozen reviewed native authority (revision and physical root identity); absent for unavailable targets. */
  targetFingerprint?: string;
  skills: Array<BundledSkill & { status: BundledSkillStatus; reason?: string }>;
  warnings: string[];
};
export const installBundledSkillsRequestSchema = z.strictObject({
  skillIds: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1).max(9)
    .refine(ids => new Set(ids).size === ids.length, "Select each Skill only once."),
  bundleDigest: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
  targetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type InstallBundledSkillsRequest = z.infer<typeof installBundledSkillsRequestSchema>;
export type BundledSkillInstallOutcome = {
  id: string;
  status: "installed" | "updated" | "unchanged" | "conflict" | "unavailable" | "error";
  error?: { code: string; message: string };
};
export type InstallBundledSkillsResult = { results: BundledSkillInstallOutcome[]; state: ProviderBundledSkillsState };
