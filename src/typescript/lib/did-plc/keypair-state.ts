// Persist keypair identity across runs so the same did:plc is reused.

export interface KeypairState {
  /** Hex-encoded secp256k1 private key. */
  privateKeyHex: string;
  /** The did:plc created for this keypair. */
  didPlc: string;
  /** ISO timestamp when the identity was first created. */
  createdAt: string;
}

/**
 * Load keypair state from a JSON file.
 * Returns null if the file does not exist.
 * Throws on malformed JSON or missing required fields.
 */
export async function loadKeypairState(path: string): Promise<KeypairState | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  const parsed = JSON.parse(text) as Partial<KeypairState>;
  if (
    typeof parsed.privateKeyHex !== "string" ||
    typeof parsed.didPlc !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error(`Malformed keypair state file: ${path}`);
  }
  return parsed as KeypairState;
}

/** Write keypair state to a JSON file (atomic via temp + rename). */
export async function saveKeypairState(path: string, state: KeypairState): Promise<void> {
  const tmp = path + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(state, null, 2));
  await Deno.rename(tmp, path);
}
