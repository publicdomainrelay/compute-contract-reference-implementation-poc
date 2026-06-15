/**
 * xrpc-relay-example — minimal Hono server hosted via the XRPC relay.
 *
 * Two modes:
 *   1. Ephemeral PDS (default): self-registers a DID via plc.directory.
 *      No external atproto account required.
 *   2. External PDS (--use-existing-atproto): logs into an existing PDS
 *      with handle + password.
 *
 * Run (ephemeral PDS — default):
 *   deno run -A mod.ts
 *
 * Run (external PDS):
 *   deno run -A mod.ts --use-existing-atproto --handle you.bsky.social --password ...
 *
 * All flags fall back to env vars when not passed on the CLI.
 *
 * Once running, your Hono app is reachable at:
 *   https://<did-with-colons-replaced-by-dashes>.<DISPATCHER_HOST>/...
 */

import { Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { Secp256k1Keypair } from "npm:@atproto/crypto";
import { Agent, CredentialSession } from "npm:@atproto/api";
import {
  createSubscriber,
  log,
  hostnameOnly,
} from "@publicdomainrelay/xrpc-relay";
import { PlcClient, PlcNotFoundError, createGenesisOp } from "@publicdomainrelay/did-plc";
import { signServiceAuth } from "@publicdomainrelay/hono-factory-atproto-repo";
import type { Signer } from "@publicdomainrelay/hono-factory-atproto-repo";
import { Command } from "@cliffy/command";

// ── CLI ────────────────────────────────────────────────────────────────

const { options } = await new Command()
  .name("xrpc-relay-example")
  .version("0.0.0")
  .description(
    "Minimal Hono server hosted via the XRPC relay.\n" +
    "\n" +
    "Defaults to ephemeral PDS mode (self-registers a DID via plc.directory).\n" +
    "Pass --use-existing-atproto to log into an existing PDS with handle + password.\n" +
    "\n" +
    "All flags fall back to their UPPER_SNAKE_CASE env var when not passed on the CLI."
  )
  .option(
    "--use-existing-atproto [useExistingAtproto:boolean]",
    "Use an existing atproto account instead of ephemeral PDS",
    { default: Deno.env.get("USE_EXISTING_ATPROTO") === "true" },
  )
  .option(
    "--dispatcher-host <host>",
    "Relay dispatcher host",
    { default: Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com" },
  )
  .option(
    "--atproto-pds <url>",
    "External PDS URL (only with --use-existing-atproto)",
    { default: Deno.env.get("ATPROTO_PDS") ?? "https://bsky.social" },
  )
  .option(
    "--handle <handle>",
    "atproto handle (only with --use-existing-atproto)",
    { default: Deno.env.get("ATPROTO_HANDLE") ?? "" },
  )
  .option(
    "--password <password>",
    "atproto password (only with --use-existing-atproto)",
    { default: Deno.env.get("ATPROTO_PASSWORD") ?? "" },
  )
  .option(
    "--fresh-keypair [freshKeypair:boolean]",
    "Generate a new keypair instead of loading from disk. " +
      "Only persisted when --keypair-path is explicitly passed.",
    { default: Deno.env.get("FRESH_KEYPAIR") === "true" },
  )
  .option(
    "--keypair-path <path>",
    "Keypair file path (default: ./keypair.json). " +
      "When passed explicitly with --fresh-keypair, the fresh keypair is persisted.",
  )
  .option(
    "--plc-directory-url <url>",
    "PLC directory URL (ephemeral PDS mode)",
    { default: Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory" },
  )
  .option(
    "--write-proxy-ref-http-to-path <path>",
    "Write HTTPS proxy ref URL to a file",
  )
  .option(
    "--write-proxy-ref-did-web-to-path <path>",
    "Write did:web proxy ref to a file",
  )
  .parse(Deno.args);

const DISPATCHER_HOST      = options.dispatcherHost;
const ATPROTO_PDS          = options.atprotoPds;
const ATPROTO_HANDLE       = options.handle;
const ATPROTO_PASSWORD     = options.password;
// --keypair-path has no default in cliffy so we can tell whether it was
// passed explicitly on the CLI (undefined) vs resolved from env / fallback.
const explicitKeypairPath: string | undefined = options.keypairPath;
const KEYPAIR_PATH         = explicitKeypairPath ?? Deno.env.get("KEYPAIR_PATH") ?? "./keypair.json";
const FRESH_KEYPAIR        = options.freshKeypair;
const PLC_DIRECTORY_URL    = options.plcDirectoryUrl;
const USE_EXISTING_ATPROTO = options.useExistingAtproto;

if (USE_EXISTING_ATPROTO && (!ATPROTO_HANDLE || !ATPROTO_PASSWORD)) {
  log("error", {
    component: "example",
    event: "missing_env",
    message: "ATPROTO_HANDLE and ATPROTO_PASSWORD must be set when using --use-existing-atproto",
  });
  Deno.exit(1);
}

// ── keypair ──────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const o = new Uint8Array(hex.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return o;
}

async function loadOrCreateKeypair(opts: {
  keypairPath: string;
  fresh?: boolean;
  /** Only meaningful with fresh — persist the generated keypair to disk. */
  persist?: boolean;
}): Promise<{ keypair: Secp256k1Keypair; privateKeyHex: string }> {
  const { keypairPath, fresh, persist } = opts;

  if (!fresh) {
    try {
      const state = JSON.parse(await Deno.readTextFile(keypairPath));
      const kp = await Secp256k1Keypair.import(hexToBytes(state.privateKeyHex));
      log("info", { component: "example", event: "keypair_loaded", did: kp.did() });
      return { keypair: kp, privateKeyHex: state.privateKeyHex };
    } catch {
      // File doesn't exist — fall through to generate.
    }
  }

  const kp = await Secp256k1Keypair.create({ exportable: true });
  const priv = bytesToHex(await kp.export());

  // With --fresh-keypair, only persist when the user explicitly passed
  // --keypair-path.  Without --fresh-keypair, always persist (normal mode).
  const shouldPersist = fresh ? persist : true;
  if (shouldPersist) {
    await Deno.writeTextFile(keypairPath, JSON.stringify({
      privateKeyHex: priv,
      did: kp.did(),
      createdAt: new Date().toISOString(),
    }, null, 2));
  }

  log("info", { component: "example", event: "keypair_generated", did: kp.did() });
  return { keypair: kp, privateKeyHex: priv };
}

const { keypair } = await loadOrCreateKeypair({
  keypairPath: KEYPAIR_PATH,
  fresh: FRESH_KEYPAIR,
  persist: !!explicitKeypairPath,
});

// ── getServiceAuthToken ──────────────────────────────────────────────

const dispatcherHostname = hostnameOnly(DISPATCHER_HOST);
const dispatcherDid = `did:web:${dispatcherHostname}`;

let getServiceAuthToken: (nsid: string) => Promise<string>;
let pdsDid: string | undefined;

if (!USE_EXISTING_ATPROTO) {
  // ── ephemeral PDS: self-register DID, self-sign service auth ───────

  const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });
  const signingKeyDid = keypair.did();

  const { did, op } = await createGenesisOp({
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
    },
    sign: (bytes) => keypair.sign(bytes),
  });

  log("info", { component: "example", event: "did_plc_registering", did });
  const alreadyExists = await plc.resolve(did).then(() => true).catch((e) => {
    if (e instanceof PlcNotFoundError) return false;
    throw e;
  });
  if (!alreadyExists) {
    await plc.submitOp(did, op);
    log("info", { component: "example", event: "did_plc_registered", did });
  } else {
    log("info", { component: "example", event: "did_plc_already_exists", did });
  }

  pdsDid = did;

  const signer: Signer = {
    did: () => did,
    sign: (bytes) => keypair.sign(bytes),
  };

  getServiceAuthToken = async (lxm: string): Promise<string> => {
    return await signServiceAuth(signer, { aud: dispatcherDid, lxm });
  };

  log("info", {
    component: "example",
    event: "ephemeral_pds_ready",
    did,
    plcDirectory: PLC_DIRECTORY_URL,
  });
} else {
  // ── external PDS: login with handle + password ─────────────────────

  const session = new CredentialSession(new URL(ATPROTO_PDS));
  await session.login({ identifier: ATPROTO_HANDLE, password: ATPROTO_PASSWORD });
  const agent = new Agent(session);
  pdsDid = session.did;
  log("info", { component: "example", event: "session_created", did: session.did });

  getServiceAuthToken = async (nsid: string): Promise<string> => {
    const res = await agent.com.atproto.server.getServiceAuth({
      aud: dispatcherDid,
      lxm: nsid,
    });
    return res.data.token;
  };
}

// ── minimal Hono app ──────────────────────────────────────────────────

const app = new Hono();
app.use("*", cors());

// Health check
app.get("/", (c) => c.json({ ok: true, server: "xrpc-relay-example", did: keypair.did() }));

// Echo endpoint
app.post("/xrpc/com.example.form.post", async (c) => {
  const body = await c.req.json().catch(() => null);
  log("info", { msg: "got form body", body: body });
  return c.json({ echo: body, callerDid: c.req.header("x-caller-did") });
});

// Dynamic greeting
app.get("/hello/:name", (c) => {
  const name = c.req.param("name");
  return c.json({ greeting: `Hello, ${name}!` });
});

// Catch-all
app.all("*", (c) => c.json({ error: "NotFound", path: new URL(c.req.url).pathname }, 404));

// ── connect subscriber ────────────────────────────────────────────────

log("info", { component: "example", event: "connecting_to_relay", host: DISPATCHER_HOST });

const sub = await createSubscriber({
  keypair,
  getServiceAuthToken,
  dispatcherHost: DISPATCHER_HOST,
  handleRequest: async (req) => {
    // Forward the relayed request to the local Hono app
    const url = new URL(`http://local${req.path}`);
    for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);
    const hasBody = !["GET", "HEAD"].includes(req.method) && req.body != null;
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (hasBody) headers["content-type"] = "application/json";
    const r = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    const res = await app.fetch(r);
    const ct = res.headers.get("content-type") ?? "application/json";
    const text = await res.text();
    let body: unknown = text;
    if (ct.includes("application/json")) {
      try { body = JSON.parse(text); } catch { /* leave as text */ }
    }
    return { status: res.status, body, contentType: ct };
  },
});

// ── proxy ref files ───────────────────────────────────────────────────

if (options.writeProxyRefHttpToPath) {
  const hostname = sub.proxyRef.replace(/^did:web:/, "");
  await Deno.writeTextFile(options.writeProxyRefHttpToPath, `https://${hostname}\n`);
  log("info", {
    component: "example",
    event: "wrote_proxy_ref_http",
    path: options.writeProxyRefHttpToPath,
    url: `https://${hostname}`,
  });
}
if (options.writeProxyRefDidWebToPath) {
  await Deno.writeTextFile(options.writeProxyRefDidWebToPath, `${sub.proxyRef}\n`);
  log("info", {
    component: "example",
    event: "wrote_proxy_ref_did_web",
    path: options.writeProxyRefDidWebToPath,
    proxyRef: sub.proxyRef,
  });
}

// ── ready ─────────────────────────────────────────────────────────────

log("info", {
  component: "example",
  event: "ready",
  mode: USE_EXISTING_ATPROTO ? "external_pds" : "ephemeral_pds",
  pdsDid,
  subdomain: sub.subdomain,
  proxyRef: sub.proxyRef,
  url: `https://${sub.subdomain}.${DISPATCHER_HOST}/`,
});
