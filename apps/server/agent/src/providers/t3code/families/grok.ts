import { GrokDriver } from "@t3tools/provider-grok/server";
import type { PmProviderInstallationMethods } from "../management.ts";
import { acpCapabilities, acpProtocolResolver, makeAcpDriverLayer } from "./acp.ts";

export const grokDriver = GrokDriver;
export const makeGrokDriverLayer = makeAcpDriverLayer;
export const grokProtocolResolver = acpProtocolResolver;
export const grokCapabilities = acpCapabilities;
/** Authentication and installation remain native, externally managed operations. */
export const grokInstallationMethods: PmProviderInstallationMethods = {};
