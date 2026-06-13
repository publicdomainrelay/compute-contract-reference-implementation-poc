// fixup-openapi.ts — download (if missing) and patch the official PLC directory
// OpenAPI spec so hey-api generates tighter TypeScript types.
//
// Run:  deno run --allow-net --allow-read --allow-write fixup-openapi.ts
//
// Patches applied:
//   1. PlcOp.verificationMethods  → additionalProperties: { type: string }
//   2. PlcOp.services              → additionalProperties: { $ref: PlcService }
//   3. Add PlcService schema
//   4. DidDocument                 → add @context property
//   5. LogEntry.cid                → fix type: cid → type: string
//   6. /export 200 response        → content-type json + array schema (was jsonlines)

import { parse, stringify } from "npm:yaml@2";

const OFFICIAL_URL =
  "https://web.plc.directory/api/plc-server-openapi3.yaml";
const OFFICIAL_PATH = new URL("./openapi.official.yaml", import.meta.url)
  .pathname;
const FIXED_PATH = new URL("./openapi.fixed.yaml", import.meta.url)
  .pathname;

// ── download official spec if not on disk ────────────────────────────

async function ensureOfficial(): Promise<string> {
  try {
    const existing = await Deno.readTextFile(OFFICIAL_PATH);
    if (existing.trim().length > 0) {
      console.log(`Using cached ${OFFICIAL_PATH}`);
      return existing;
    }
  } catch {
    // not found — download
  }
  console.log(`Downloading ${OFFICIAL_URL} …`);
  const res = await fetch(OFFICIAL_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to download official spec: ${res.status} ${res.statusText}`,
    );
  }
  const text = await res.text();
  await Deno.writeTextFile(OFFICIAL_PATH, text);
  console.log(`Saved ${OFFICIAL_PATH} (${text.length} bytes)`);
  return text;
}

// ── patch helpers ─────────────────────────────────────────────────────

function ensure(obj: Record<string, unknown>, key: string, fallback: () => unknown) {
  if (!(key in obj)) obj[key] = fallback();
  return obj[key];
}

// ── apply patches ─────────────────────────────────────────────────────

function patch(spec: Record<string, unknown>): void {
  const schemas = spec.components?.schemas as Record<
    string,
    Record<string, unknown>
  >;
  if (!schemas) throw new Error("Missing components.schemas");

  // 1. PlcOp.verificationMethods → additionalProperties: { type: string }
  const plcOp = schemas.PlcOp;
  if (!plcOp?.properties) throw new Error("Missing PlcOp.properties");
  const vmProps = (plcOp.properties as Record<string, Record<string, unknown>>)
    .verificationMethods;
  if (!vmProps) throw new Error("Missing PlcOp.properties.verificationMethods");
  vmProps.additionalProperties = { type: "string" };

  // 2. PlcOp.services → additionalProperties: { $ref: '#/components/schemas/PlcService' }
  const svcProps = (plcOp.properties as Record<string, Record<string, unknown>>)
    .services;
  if (!svcProps) throw new Error("Missing PlcOp.properties.services");
  svcProps.additionalProperties = {
    $ref: "#/components/schemas/PlcService",
  };

  // 3. Add PlcService schema (before Operation)
  const entries = Object.entries(schemas);
  const opIdx = entries.findIndex(([k]) => k === "Operation");
  if (opIdx === -1) throw new Error("Missing Operation schema");
  entries.splice(opIdx, 0, [
    "PlcService",
    {
      type: "object",
      required: ["type", "endpoint"],
      properties: {
        type: { type: "string" },
        endpoint: { type: "string" },
      },
    },
  ]);
  // Rebuild schemas in new order
  for (const [k] of Object.keys(schemas)) delete schemas[k];
  for (const [k, v] of entries) schemas[k] = v;

  // 4. DidDocument → add @context
  const didDoc = schemas.DidDocument;
  if (!didDoc?.properties) throw new Error("Missing DidDocument.properties");
  (didDoc.properties as Record<string, unknown>)["@context"] = {
    type: "array",
    items: { type: "string" },
  };

  // 5. LogEntry.cid → type: string (was type: cid)
  const logEntry = schemas.LogEntry;
  if (!logEntry?.properties) throw new Error("Missing LogEntry.properties");
  const cidProp = (logEntry.properties as Record<string, Record<string, unknown>>).cid;
  if (!cidProp) throw new Error("Missing LogEntry.properties.cid");
  cidProp.type = "string";

  // 6. /export 200 response → application/json + array schema
  const exportPath = (spec.paths as Record<string, Record<string, unknown>>)["/export"];
  if (!exportPath?.get) throw new Error("Missing /export.get");
  const getOp = exportPath.get as Record<string, unknown>;
  const responses = getOp.responses as Record<string, Record<string, unknown>>;
  const resp200 = responses["200"];
  if (!resp200?.content) throw new Error("Missing /export 200 response content");
  resp200.content = {
    "application/json": {
      schema: {
        type: "array",
        items: { $ref: "#/components/schemas/LogEntry" },
      },
    },
  };

  console.log("Patches applied: 6/6");
}

// ── main ──────────────────────────────────────────────────────────────

async function main() {
  const yamlText = await ensureOfficial();
  const spec = parse(yamlText) as Record<string, unknown>;
  if (!spec || typeof spec !== "object") throw new Error("Failed to parse spec");

  patch(spec);

  const out = stringify(spec, { lineWidth: 0 });
  // Add trailing newline
  await Deno.writeTextFile(FIXED_PATH, out.endsWith("\n") ? out : out + "\n");
  console.log(`Wrote ${FIXED_PATH} (${out.length} bytes)`);
}

main().catch((err) => {
  console.error("fixup-openapi failed:", err.message);
  Deno.exit(1);
});
