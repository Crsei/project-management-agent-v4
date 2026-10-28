import type { ComponentType } from "react";

export type Copy = { "zh-CN": string; en: string };
export type ShowcasePage = {
  id: string;
  group: string;
  title: Copy;
  description: Copy;
  scenarios: readonly { id: string; name: Copy }[];
  deferred?: boolean;
  Component: ComponentType<{ scenario: string }>;
};
