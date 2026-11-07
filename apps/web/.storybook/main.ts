import type { StorybookConfig } from "@storybook/react-vite"

const config: StorybookConfig = {
  stories: ["../src/features/pm/components/*.stories.tsx", "../../../packages/ui/src/**/*.stories.tsx"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
}
export default config
