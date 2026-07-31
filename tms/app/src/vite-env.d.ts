/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_DEV_SUB?: string;
  readonly VITE_DEV_GROUPS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
