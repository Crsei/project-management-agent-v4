import type { ComposerSource, Copy } from "./model"

/** Fixed local scenario input. Product reading models never require a fake reply. */
export interface ComposerDemoSource extends ComposerSource {
  reply: Copy
}
