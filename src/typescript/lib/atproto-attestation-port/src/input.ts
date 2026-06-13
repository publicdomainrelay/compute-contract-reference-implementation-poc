import type { JsonObject } from "./types.ts";
import { AnyInputError } from "./errors.ts";
// Re-export for the public API (mirrors Rust crate re-exports)
export { AnyInputError };

/**
 * Mirrors `atproto_attestation::input::AnyInput<S>`.
 *
 * Holds either a raw JSON string (parsed on demand) or a serializable value.
 */
export class AnyInput<T> {
  private readonly variant: "string" | "serialize";
  private readonly jsonString?: string;
  private readonly value?: T;

  private constructor(variant: "string", payload: string);
  private constructor(variant: "serialize", payload: T);
  private constructor(
    variant: "string" | "serialize",
    payload: string | T,
  ) {
    this.variant = variant;
    if (variant === "string") {
      this.jsonString = payload as string;
    } else {
      this.value = payload as T;
    }
  }

  /**
   * Create an AnyInput from a raw JSON string.
   */
  static string(json: string): AnyInput<never> {
    return new AnyInput<never>("string", json);
  }

  /**
   * Create an AnyInput from a serializable value.
   */
  static serialize<T>(value: T): AnyInput<T> {
    return new AnyInput<T>("serialize", value);
  }

  /**
   * Returns `true` if the inner value was provided as a JSON string.
   */
  isString(): boolean {
    return this.variant === "string";
  }

  /**
   * Returns `true` if the inner value was provided as a serialized value.
   */
  isSerialize(): boolean {
    return this.variant === "serialize";
  }

  /**
   * Unwraps the inner value as a parsed JSON object.
   *
   * - For the **String** variant the raw string is `JSON.parse`'d.
   * - For the **Serialize** variant the value is returned directly when it is
   *   already a plain object, otherwise it is round-tripped through JSON.
   *
   * @throws {AnyInputError} when the value cannot be converted to a JSON object.
   */
  unwrap(): JsonObject {
    if (this.variant === "string") {
      return parseString(this.jsonString!);
    }

    // Serialize variant
    const val = this.value!;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return val as unknown as JsonObject;
    }
    // Round-trip through JSON to coerce primitives etc. into a plain object.
    return parseString(JSON.stringify(val));
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseString(raw: string): JsonObject {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AnyInputError("Value is not a JSON object");
    }
    return parsed as JsonObject;
  } catch (err) {
    if (err instanceof AnyInputError) throw err;
    throw new AnyInputError(
      `Failed to parse input: ${(err as Error).message}`,
    );
  }
}
