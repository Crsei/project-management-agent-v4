import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface ElectronWebviewAttributes extends HTMLAttributes<HTMLElement> {
  src?: string;
  partition?: string;
  preload?: string;
  allowpopups?: boolean;
  webpreferences?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<ElectronWebviewAttributes, HTMLElement>;
    }
  }
}
