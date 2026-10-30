import type { PmProviderApplicationOptions } from "./application.ts";
import { makePmProviderFamily } from "./registration.ts";
import { openCodeDriver, makeOpenCodeDriverLayer, openCodeProtocolResolver, openCodeCapabilities, openCodeInstallationMethods } from "./families/opencode.ts";
import { codexDriver, makeCodexDriverLayer, codexProtocolResolver, codexCapabilities, codexInstallationMethods } from "./families/codex.ts";
import { claudeDriver, makeClaudeDriverLayer, claudeProtocolResolver, claudeCapabilities } from "./families/claude.ts";
import { antigravityDriver, makeAntigravityDriverLayer, antigravityProtocolResolver, antigravityCapabilities, antigravityInstallationMethods } from "./families/antigravity.ts";
import { cursorDriver, makeCursorDriverLayer, cursorProtocolResolver, cursorCapabilities, cursorInstallationMethods } from "./families/cursor.ts";
import { museDriver, makeMuseDriverLayer, museProtocolResolver, museCapabilities, museInstallationMethods } from "./families/muse.ts";
import { piDriver, makePiDriverLayer, piProtocolResolver, piCapabilities, piInstallationMethods } from "./families/pi.ts";
import { grokDriver, makeGrokDriverLayer, grokProtocolResolver, grokCapabilities, grokInstallationMethods } from "./families/grok.ts";
import { fxDriver, makeFxDriverLayer, fxProtocolResolver, fxCapabilities, fxInstallationMethods } from "./families/fx.ts";
import { acpRegistryDriver, makeAcpRegistryDriverLayer, acpRegistryProtocolResolver, acpRegistryCapabilities, acpRegistryInstallationMethods } from "./families/acp-registry.ts";

/** Concrete original drivers only; an unregistered family never falls back here. */
export const providerApplicationOptions: PmProviderApplicationOptions = {
  families: new Map([
    makePmProviderFamily(openCodeDriver, makeOpenCodeDriverLayer),
    makePmProviderFamily(codexDriver, makeCodexDriverLayer),
    makePmProviderFamily(claudeDriver, makeClaudeDriverLayer),
    makePmProviderFamily(antigravityDriver, makeAntigravityDriverLayer),
    makePmProviderFamily(cursorDriver, makeCursorDriverLayer),
    makePmProviderFamily(museDriver, makeMuseDriverLayer),
    makePmProviderFamily(piDriver, makePiDriverLayer),
    makePmProviderFamily(grokDriver, makeGrokDriverLayer),
    makePmProviderFamily(fxDriver, makeFxDriverLayer),
    makePmProviderFamily(acpRegistryDriver, makeAcpRegistryDriverLayer),
  ].map(family => [family.driverKind, family] as const)),
  protocols: new Map([
    ["opencode", openCodeProtocolResolver], ["codex", codexProtocolResolver], ["claude", claudeProtocolResolver],
    ["antigravity", antigravityProtocolResolver], ["cursor", cursorProtocolResolver], ["muse", museProtocolResolver],
    ["pi", piProtocolResolver], ["grok", grokProtocolResolver], ["fx", fxProtocolResolver], ["acpRegistry", acpRegistryProtocolResolver],
  ]),
  capabilities: new Map([
    ["opencode", openCodeCapabilities], ["codex", codexCapabilities], ["claude", claudeCapabilities],
    ["antigravity", antigravityCapabilities], ["cursor", cursorCapabilities], ["muse", museCapabilities],
    ["pi", piCapabilities], ["grok", grokCapabilities], ["fx", fxCapabilities], ["acpRegistry", acpRegistryCapabilities],
  ]),
  installations: new Map([
    ["opencode", openCodeInstallationMethods], ["codex", codexInstallationMethods],
    ["antigravity", antigravityInstallationMethods], ["cursor", cursorInstallationMethods], ["muse", museInstallationMethods],
    ["pi", piInstallationMethods], ["grok", grokInstallationMethods], ["fx", fxInstallationMethods], ["acpRegistry", acpRegistryInstallationMethods],
  ]),
};
