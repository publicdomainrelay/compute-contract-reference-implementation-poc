import {
  createInlineAttestation,
  verifyRecord,
  AnyInput,
  type KeyData,
  type KeyResolver,
  type RecordResolver,
} from "../mod.ts";

// --- Key generation helper ---
async function generateP256KeyPair(): Promise<{
  privateKey: KeyData;
  publicKey: KeyData;
  did: string;
}> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", kp.privateKey),
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", kp.publicKey),
  );

  // Simple did:key derivation (P-256: multicodec 0x1200, base58btc)
  const mcPrefix = new Uint8Array([0x80, 0x24]); // varint for 0x1200
  const didKeyBytes = new Uint8Array(mcPrefix.length + spki.length);
  didKeyBytes.set(mcPrefix);
  didKeyBytes.set(spki, mcPrefix.length);

  // base58btc encode (simplified — just use hex for demo)
  const did = `did:key:z${toBase58(didKeyBytes)}`;

  return {
    privateKey: { keyType: "P256Private", keyBytes: pkcs8, did },
    publicKey: { keyType: "P256Public", keyBytes: spki, did },
    did,
  };
}

// Simple base58 encoder (for demo only — use proper library in prod)
function toBase58(bytes: Uint8Array): string {
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt(
    "0x" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );
  let result = "";
  while (num > 0n) {
    result = ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

// --- Main ---
async function main() {
  console.log("Generating P-256 key pair...");
  const { privateKey, publicKey, did } = await generateP256KeyPair();
  console.log("DID:", did);

  // Create a record
  const record = {
    $type: "app.bsky.feed.post",
    text: "Hello from Deno attestation!",
    createdAt: new Date().toISOString(),
  };

  // Create attestation metadata
  const metadata = {
    $type: "com.example.attestation",
    timestamp: new Date().toISOString(),
    attestor: "deno-attestation-example",
  };

  console.log("\nCreating inline attestation...");
  const signed = await createInlineAttestation(
    AnyInput.serialize(record),
    AnyInput.serialize(metadata),
    "did:plc:example-repo",
    privateKey,
  );

  console.log("Signed record:", JSON.stringify(signed, null, 2));

  // Verify the attestation
  console.log("\nVerifying attestation...");
  const keyResolver: KeyResolver = {
    async resolveKey(d: string) {
      if (d === did) return publicKey;
      throw new Error(`Unknown DID: ${d}`);
    },
  };

  const recordResolver: RecordResolver = {
    async resolve<T>(_aturi: string): Promise<T> {
      throw new Error("No remote records in this example");
    },
  };

  await verifyRecord(
    AnyInput.serialize(signed),
    "did:plc:example-repo",
    keyResolver,
    recordResolver,
  );

  console.log("✅ Verification passed!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  Deno.exit(1);
});
