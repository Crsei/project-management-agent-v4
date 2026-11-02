import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "Oh My Pi",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 32 32",
    fill: { light: "#26344B", dark: "#DCE7FA" },
    paths: [
      { d: "M16 2a14 14 0 1 0 0 28 14 14 0 0 0 0-28Zm0 4a10 10 0 1 1 0 20 10 10 0 0 1 0-20Z", fillRule: "evenodd" },
      { d: "M9 11h14v4h-3v8h-4v-8h-3v8H9Z" },
    ],
  },
});
