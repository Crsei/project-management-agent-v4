/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_WORKSPACE_URL?: string;
  readonly PUBLIC_DESKTOP_RELEASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
