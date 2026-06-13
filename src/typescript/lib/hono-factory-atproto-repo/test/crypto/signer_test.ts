import { assertEquals, assert } from "@std/assert";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  createVerifier,
  signerFromKeypair,
  signerFromPrivateKeyHex,
} from "../../crypto/signer.ts";

Deno.test("signer: did() returns expected DID", async () => {
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  assertEquals(signer.did(), kp.did());
});

Deno.test("signer: sign→verify round-trip", async () => {
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const verifier = createVerifier();

  const bytes = new TextEncoder().encode("hello world");
  const sig = await signer.sign(bytes);
  const ok = await verifier.verify(signer.did(), bytes, sig);
  assert(ok, "signature should verify");
});

Deno.test("signer: wrong signature fails verification", async () => {
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const verifier = createVerifier();

  const bytes = new TextEncoder().encode("hello world");
  const sig = await signer.sign(bytes);

  const tampered = new TextEncoder().encode("HELLO WORLD");
  const ok = await verifier.verify(signer.did(), tampered, sig);
  assert(!ok, "tampered message should fail verification");
});

Deno.test("signer: wrong DID fails verification", async () => {
  const kp1 = await Secp256k1Keypair.create();
  const kp2 = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp1);
  const verifier = createVerifier();

  const bytes = new TextEncoder().encode("hello world");
  const sig = await signer.sign(bytes);

  const ok = await verifier.verify(kp2.did(), bytes, sig);
  assert(!ok, "wrong DID should fail verification");
});

Deno.test("signer: signerFromPrivateKeyHex creates signer with same DID", async () => {
  const kp = await Secp256k1Keypair.create({ exportable: true });
  const privKey = await kp.export();
  const hex = [...privKey].map((b) => b.toString(16).padStart(2, "0")).join("");

  const signer = await signerFromPrivateKeyHex(hex);
  assertEquals(signer.did(), kp.did());

  const bytes = new TextEncoder().encode("test");
  const sig = await signer.sign(bytes);
  const ok = await createVerifier().verify(signer.did(), bytes, sig);
  assert(ok, "imported keypair should sign and verify");
});
