/**
 * ephemeral-package-registry — lightweight atproto PDS that acts as a package
 * registry. Wraps createPackageRegistryFactory with relay registration so the
 * registry is reachable through an XRPC relay tunnel.
 *
 * Supports three backing stores, selectable via `--store` CLI flag or
 * `PACKAGE_REGISTRY_STORE` env var:
 *   "git"   — remote git repository (needs --git-url)
 *   "local" — local filesystem directory (needs --base-dir)
 *   "pds"   — AT Protocol PDS records (default, in-process)
 *
 * Exports:
 *   createEphemeralPackageRegistry() — returns running registry + relay registration
 *   EphemeralPackageRegistry, EphemeralPackageRegistryOptions types
 */

import { Secp256k1Keypair } from "@atproto/crypto";
import {
  createRepoFactory,
  MemoryStorage,
  signServiceAuth,
} from "@publicdomainrelay/hono-factory-atproto-repo";
import type { Signer } from "@publicdomainrelay/hono-factory-atproto-repo";
import { PlcClient, PlcNotFoundError, createGenesisOp } from "@publicdomainrelay/did-plc";
import { runSubscriber } from "@publicdomainrelay/xrpc-relay";
import { createSubscriberFactory } from "@publicdomainrelay/hono-factory-xrpc-subscriber";
import { IdResolver } from "@atproto/identity";
import type { PackageStore } from "@publicdomainrelay/datastore-package";
import { createRemoteGitStore } from "@publicdomainrelay/datastore-remote-git";
import { createLocalFsStore } from "@publicdomainrelay/datastore-local-fs";
import { createPdsStore } from "@publicdomainrelay/datastore-pds";
import { Command } from "@cliffy/command";
import { createPackageRegistryFactory } from "@publicdomainrelay/hono-factory-package-registry";

// ── options ──────────────────────────────────────────────────────────

export type StoreMode = "git" | "local" | "pds";

export interface EphemeralPackageRegistryOptions {
  /** Backing store mode (default: "pds") */
  storeMode?: StoreMode;
  /** Git: remote repository URL */
  gitUrl?: string;
  /** Local FS: base directory for packages */
  baseDir?: string;
  /** PDS: repo DID (defaults to own DID) */
  pdsRepoDid?: string;
  port?: number;
  privateKeyHex?: string;
  plcDirectoryUrl?: string;
  dispatcherHost?: string;
  label?: string;
  /** Skip XRPC relay, serve directly via HTTP (env: DIRECT=1) */
  direct?: boolean;
}

export interface EphemeralPackageRegistry {
  did: string;
  signer: Signer;
  keypair: Secp256k1Keypair;
  app: ReturnType<typeof createPackageRegistryFactory>;
  store: PackageStore;
  relaySubdomain: string;
  relayProxyRef: string;
  /** Resolves when relay registration completes */
  ready: Promise<{ subdomain: string; proxyRef: string }>;
  stop: () => void;
}

// ── createEphemeralPackageRegistry ─────────────────────────────────────

export async function createEphemeralPackageRegistry(
  opts: EphemeralPackageRegistryOptions = {},
): Promise<EphemeralPackageRegistry> {
  const DISPATCHER_HOST = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
  const PLC_DIRECTORY_URL = opts.plcDirectoryUrl ?? Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
  const PORT = opts.port ?? parseInt(Deno.env.get("PORT") ?? "0");
  const PRIVATE_KEY_HEX = opts.privateKeyHex ?? Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const LABEL = opts.label ?? "ephemeral-package-registry";
  const STORE_MODE: StoreMode = opts.storeMode ??
    (Deno.env.get("PACKAGE_REGISTRY_STORE") as StoreMode | undefined) ??
    "pds";
  const DIRECT = opts.direct ??
    Deno.env.get("DIRECT") === "1";

  const logInfo = (obj: Record<string, unknown>) => console.log(JSON.stringify(obj));
  const log = (
    severity: string,
    msg: string,
    extra?: Record<string, unknown>,
  ) => logInfo({ label: LABEL, severity, message: msg, ...(extra ?? {}) });

  // ── keypair ────────────────────────────────────────────────────
  const keypair = PRIVATE_KEY_HEX
    ? await Secp256k1Keypair.import(PRIVATE_KEY_HEX)
    : await Secp256k1Keypair.create({ exportable: true });

  const signingKeyDid = keypair.did();

  // ── did:plc registration (skip when no relay) ───────────────────
  let did: string;

  if (!DIRECT) {
    const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });
    const genesis = await createGenesisOp({
      rotationKeys: [signingKeyDid],
      verificationMethods: { atproto: signingKeyDid },
      alsoKnownAs: [
        `at://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
      ],
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
        },
        pdr_temp_package_registry: {
          type: "PDRTempPackageRegistry",
          endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
        },
      },
      sign: (bytes: Uint8Array) => keypair.sign(bytes),
    });
    did = genesis.did;

    logInfo({ event: "pkg_registry_did_plc_registering", did });
    const alreadyExists = await plc.resolve(did).then(() => true).catch((e) => {
      if (e instanceof PlcNotFoundError) return false;
      throw e;
    });
    if (!alreadyExists) {
      await plc.submitOp(did, genesis.op);
      logInfo({ event: "pkg_registry_did_plc_registered", did });
    } else {
      logInfo({ event: "pkg_registry_did_plc_already_exists", did });
    }
  } else {
    did = signingKeyDid;
    logInfo({ event: "pkg_registry_no_xrpc_relay", did });
  }

  // ── signer ─────────────────────────────────────────────────────
  const signer: Signer = {
    did: () => did,
    sign: (bytes: Uint8Array) => keypair.sign(bytes),
  };

  // ── backing store ──────────────────────────────────────────────
  let store: PackageStore;

  if (STORE_MODE === "git") {
    const gitUrl = opts.gitUrl ?? Deno.env.get("PACKAGE_REGISTRY_GIT_URL");
    if (!gitUrl) throw new Error("git store mode requires --git-url or PACKAGE_REGISTRY_GIT_URL");
    store = createRemoteGitStore({ url: gitUrl });
    logInfo({ event: "pkg_registry_store_git", url: gitUrl });
  } else if (STORE_MODE === "local") {
    const baseDir = opts.baseDir ?? Deno.env.get("PACKAGE_REGISTRY_BASE_DIR");
    if (!baseDir) throw new Error("local store mode requires --base-dir or PACKAGE_REGISTRY_BASE_DIR");
    store = createLocalFsStore({ baseDir });
    logInfo({ event: "pkg_registry_store_local", baseDir });
  } else {
    // PDS mode: create a repo factory and use it as the store
    if (DIRECT) {
      throw new Error("PDS store mode requires XRPC relay (cannot use --direct with --store pds)");
    }
    const { api } = createRepoFactory({
      storage: new MemoryStorage(),
      signer,
      baseOrigin: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
    });
    store = createPdsStore({ api, repoDid: opts.pdsRepoDid ?? did });
    logInfo({ event: "pkg_registry_store_pds", repoDid: did });
  }

  // ── registry app ───────────────────────────────────────────────
  const app = createPackageRegistryFactory({ store, label: LABEL });

  // ── did:web document (only when relay is active) ────────────────
  if (!DIRECT) {
    const atprotoPublicKeyMultibase = signingKeyDid.replace("did:key:", "");

    app.get("/.well-known/did.json", (c) => {
      const host = c.req.header("host") ?? "";
      const webDid = `did:web:${host}`;
      return c.json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: webDid,
        verificationMethod: [{
          id: `${webDid}#atproto`,
          type: "Multikey",
          controller: webDid,
          publicKeyMultibase: atprotoPublicKeyMultibase,
        }],
        service: [{
          id: "#pdr_temp_package_registry",
          type: "PDRTempPackageRegistry",
          serviceEndpoint: `https://${host}`,
        }],
      });
    });
  }

  // ── relay ready promise ─────────────────────────────────────────
  let _resolveReady: ((info: { subdomain: string; proxyRef: string }) => void) | null = null;
  const relayReady = new Promise<{ subdomain: string; proxyRef: string }>((resolve) => {
    _resolveReady = resolve;
  });
  function resolveReady(info: { subdomain: string; proxyRef: string }) {
    _resolveReady?.(info);
  }
  let _relaySubdomain = "";
  let _relayProxyRef = "";

  // ── HTTP server ─────────────────────────────────────────────────
  const serverController = new AbortController();
  const portIsExplicit = opts.port !== undefined || Deno.env.get("PORT") !== undefined;
  // In no-relay mode, always start an HTTP server
  const shouldListen = DIRECT || (portIsExplicit && PORT >= 0);
  const listenPort = DIRECT && !portIsExplicit
    ? 0 // auto-assign a port
    : PORT;

  if (shouldListen) {
    Deno.serve({ port: listenPort, signal: serverController.signal }, app.fetch);
    logInfo({ event: "pkg_registry_listening", port: listenPort, did });
  } else {
    logInfo({ event: "pkg_registry_no_http_server", did });
  }

  // ── relay subscriber (skip when no relay) ───────────────────────
  let relayController: { stop: () => void } = { stop: () => {} };

  if (!DIRECT) {
    const dispatcherDid = `did:web:${DISPATCHER_HOST}`;

    async function getServiceAuthToken(lxm: string): Promise<string> {
      return await signServiceAuth(signer, { aud: dispatcherDid, lxm });
    }

    const { handleRequest } = createSubscriberFactory({ app });

    const ctrl = runSubscriber({
      label: LABEL,
      keypair,
      getServiceAuthToken,
      dispatcherHost: DISPATCHER_HOST,
      handleRequest,
      subscribe: undefined,
      onLog: (e) => logInfo({
        event: "pkg_registry_relay",
        severity: e.severity,
        message: e.message,
      }),
      onRegistered: (info) => {
        _relaySubdomain = info.subdomain;
        _relayProxyRef = info.proxyRef;
        logInfo({ event: "pkg_registry_relay_registered", subdomain: info.subdomain, proxyRef: info.proxyRef });
        resolveReady?.(info);
      },
      onSubscriptionOpen: (sub) => logInfo({
        event: "pkg_registry_relay_subscription_open",
        subscriptionId: sub.subscriptionId,
      }),
      onStatus: (status) => logInfo({ event: "pkg_registry_relay_status", status }),
    });
    relayController = ctrl;
    logInfo({ event: "pkg_registry_relay_connecting", dispatcherHost: DISPATCHER_HOST });
  } else {
    // In no-relay mode, resolve ready immediately
    if (resolveReady) resolveReady({ subdomain: "", proxyRef: "" });
  }

  return {
    did,
    signer,
    keypair,
    app,
    store,
    get relaySubdomain() { return _relaySubdomain; },
    get relayProxyRef() { return _relayProxyRef; },
    ready: relayReady,
    stop: () => {
      relayController.stop();
      if (shouldListen) serverController.abort();
    },
  };
}

// ── CLI entry ─────────────────────────────────────────────────────────

if (import.meta.main) {
  const { options } = await new Command()
    .name("ephemeral-package-registry")
    .version("0.0.0")
    .description(
      "Lightweight atproto PDS that acts as a package registry, " +
      "reachable through an XRPC relay tunnel.\n" +
      "\n" +
      "Options without a CLI flag default from environment variables.\n" +
      "  PACKAGE_REGISTRY_STORE, PACKAGE_REGISTRY_GIT_URL,\n" +
      "  PACKAGE_REGISTRY_BASE_DIR, PORT, REPO_PRIVATE_KEY_HEX,\n" +
      "  PLC_DIRECTORY_URL, DISPATCHER_HOST, DIRECT=1",
    )
    .option(
      "--store <mode>",
      'Backing store: "git", "local", or "pds" (default)',
      { default: "pds" },
    )
    .option(
      "--git-url <url>",
      "Remote git repository URL (required for git store)",
    )
    .option(
      "--base-dir <path>",
      "Local filesystem directory (required for local store)",
    )
    .option("--port <port>", "HTTP port to listen on")
    .option("--private-key-hex <hex>", "Secp256k1 private key hex")
    .option("--plc-directory-url <url>", "PLC directory base URL")
    .option("--dispatcher-host <host>", "Relay dispatcher hostname")
    .option(
      "--label <label>",
      "Log label",
      { default: "ephemeral-package-registry" },
    )
    .option(
      "--write-proxy-ref-http-to-path <path>",
      "Write HTTPS proxy ref URL to a file",
    )
    .option(
      "--write-proxy-ref-did-web-to-path <path>",
      "Write did:web proxy ref to a file",
    )
    .option(
      "--direct [direct:boolean]",
      "Skip XRPC relay; serve directly via HTTP (env: DIRECT=1)",
      { default: false },
    )
    .parse(Deno.args);

  const storeMode = options.store as StoreMode;
  const port = options.port ? parseInt(options.port) : undefined;

  const registry = await createEphemeralPackageRegistry({
    storeMode,
    gitUrl: options.gitUrl,
    baseDir: options.baseDir,
    port,
    privateKeyHex: options.privateKeyHex,
    plcDirectoryUrl: options.plcDirectoryUrl,
    dispatcherHost: options.dispatcherHost,
    label: options.label,
    direct: options.direct,
  });

  const readyInfo = await registry.ready;
  console.log(JSON.stringify({
    event: "pkg_registry_ready",
    did: registry.did,
    subdomain: readyInfo.subdomain,
    proxyRef: readyInfo.proxyRef,
    storeMode,
  }));

  // Write proxy ref files if requested
  if (options.writeProxyRefHttpToPath) {
    const hostname = readyInfo.proxyRef.replace(/^did:web:/, "");
    await Deno.writeTextFile(options.writeProxyRefHttpToPath, `https://${hostname}\n`);
  }
  if (options.writeProxyRefDidWebToPath) {
    await Deno.writeTextFile(options.writeProxyRefDidWebToPath, `${readyInfo.proxyRef}\n`);
  }

  // Keep alive
  await new Promise(() => {});
}
