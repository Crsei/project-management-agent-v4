import type { PmAutomationTemplateId } from './automation-pm.ts';

/**
 * Host-owned catalog DTOs. Shape adapted from the pinned OpenHands automation
 * interface (MIT, vendor/openhands-automations/LICENSE.extensions).
 * Catalog manifests, bundle bytes and source assembly belong to automation-resources.
 */
export interface AutomationCatalogField {
  type: 'text' | 'textarea' | 'select' | 'number' | 'cron' | 'timezone' | 'repo-picker' | 'llm-profile' | 'event-source' | 'event-type' | 'plugin-sources' | 'tarball-upload';
  label: string;
  help: string;
  placeholder?: string;
  default?: string | number | boolean | null;
  required: boolean;
  provider?: 'github' | 'gitlab' | 'bitbucket';
  multiple?: true;
  options?: { value: string; label: string }[];
  constraints?: { minLength?: number; maxLength?: number; min?: number; max?: number; format?: 'safeExpressionLiteral' };
}

type CatalogFields = Record<string, AutomationCatalogField>;
type CatalogConfigValue = string | number | boolean | null | CatalogConfigValue[] | { [key: string]: CatalogConfigValue };
type CatalogAction = { label: string; help: string; features: string[]; args: CatalogFields };

/** Manual triggers and registered native handlers are host additions, not vendor-schema mutations. */
export interface AutomationCatalogTemplate {
  id: string;
  version?: string;
  name: string;
  category: string;
  icon?: 'layout-dashboard' | 'sparkles' | 'bot' | 'circle-alert' | 'activity' | 'timer';
  description: string;
  requires: { integrations: Record<string, { message?: string; required?: false }>; features?: string[] };
  popularityRank: number;
  estimatedSetupMinutes: number;
  skill?: string;
  exampleImplementation: string;
  impact?: { basis: 'completed-runs'; one: string; other: string };
  source?: 'openhands' | 'pm';
  sourceCategory?: string;
  maturity?: 'stable' | 'beta';
  recommended?: boolean;
  scenario?: string;
  triggers?: ('manual' | 'cron' | 'event')[];
  setup?: {
    version: '1.0';
    mode: 'direct' | 'assisted';
    native?: { templateId: PmAutomationTemplateId };
    form: { note?: string; args: CatalogFields; triggers?: Partial<Record<'manual' | 'cron' | 'event', CatalogFields>> };
    prompt?: string;
    bundle?: { entrypoint: string; setupScript?: string; timeout?: number; files: Record<string, string>; config: Record<string, CatalogConfigValue> };
    actions?: {
      prompt?: CatalogAction & { prompt: string };
      plugin?: CatalogAction & { prompt: string; plugins: string };
      upload?: CatalogAction & { tarballPath: string; entrypoint: string; setupScript?: string };
    };
    filter?: string;
    message?: string;
  };
}
