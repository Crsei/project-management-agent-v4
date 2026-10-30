import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@agent/components/ui/tooltip";
import { App } from "@agent/src/app";
import "@agent/styles/globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
