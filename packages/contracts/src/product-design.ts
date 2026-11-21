import { z } from 'zod';

export const productDesignSchema = z.strictObject({
  versionId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(200), notes: z.string().max(6000),
});
export type ProductDesign = z.infer<typeof productDesignSchema>;
export const designBundleSchema = z.strictObject({
  versionId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fileName: z.string(),
  assets: z.array(z.strictObject({ name: z.string(), mediaType: z.string(), base64: z.string() })).max(64),
  unsupported: z.array(z.string()).max(256),
});
export type DesignBundle = z.infer<typeof designBundleSchema>;
