/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Relay dispatcher host. Defaults to xrpc.fedproxy.com when unset. */
  readonly VITE_DISPATCHER_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
