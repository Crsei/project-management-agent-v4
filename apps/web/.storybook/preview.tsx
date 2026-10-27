import type { Preview } from "@storybook/react-vite"
import { AppProviders } from "../src/providers/app-providers"
import "../src/index.css"

const preview: Preview = {
  decorators: [(Story) => <AppProviders><div className="min-h-screen bg-background p-6 text-foreground"><Story /></div></AppProviders>],
  parameters: { layout: "fullscreen" },
}
export default preview
