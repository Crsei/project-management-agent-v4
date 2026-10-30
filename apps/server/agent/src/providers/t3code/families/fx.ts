import { FxDriver } from "@t3tools/provider-fx/server";
import type { PmProviderInstallationMethods } from "../management.ts";
import { acpCapabilities, acpProtocolResolver, makeAcpDriverLayer } from "./acp.ts";

export const fxDriver = FxDriver;
export const makeFxDriverLayer = makeAcpDriverLayer;
export const fxProtocolResolver = acpProtocolResolver;
export const fxCapabilities = acpCapabilities;
/** Authentication and installation remain native, externally managed operations. */
export const fxInstallationMethods: PmProviderInstallationMethods = {};
