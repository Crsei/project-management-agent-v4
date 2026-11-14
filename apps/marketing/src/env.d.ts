/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_APP_URL?: string;
  readonly PUBLIC_SOURCE_URL?: string;
  readonly PUBLIC_DESKTOP_RELEASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
