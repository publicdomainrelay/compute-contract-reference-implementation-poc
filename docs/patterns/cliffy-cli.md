# CLI with Cliffy + Env Vars

Type-safe CLI using `@cliffy/command` with env var fallbacks, `import.meta.main` guard, and module-as-library dual use.

## Where used

- `ephemeral-package-registry/main.ts` — canonical cliffy example
- `xrpc-relay-pds/cli.ts` — manual flag parsing (pre-cliffy)
- `qemu/qemu-standalone.ts` — regex-based flag parsing
- `scripts/install-prod.ts` — env-only, no CLI flags
- `lib/compute-provider-digitalocean/mod.ts` — env-only config
- `lib/compute-provider-local/mod.ts` — env cascade with defaults

## Canonical pattern: cliffy + env cascade

```ts
// ephemeral-package-registry/main.ts
import { Command } from "@cliffy/command";

// 1. Module is both library and CLI via import.meta.main guard
export async function createXxx(opts: XxxOptions = {}): Promise<Xxx> {
  // opts take priority, then env vars, then defaults
  const PORT = opts.port ??
    parseInt(Deno.env.get("PORT") ?? "0");
  const STORE_MODE = opts.storeMode ??
    (Deno.env.get("STORE_MODE") as StoreMode) ??
    "pds";
  // ...
}

// 2. CLI entry only runs when executed directly
if (import.meta.main) {
  const { options } = await new Command()
    .name("my-cli")
    .version("0.1.0")
    .description("What it does.\n\nEnv vars: FOO, BAR, BAZ=1")
    .option("--store <mode>", 'Backing store: "git", "local", or "pds"', {
      default: "pds",
    })
    .option("--port <port>", "HTTP port")
    .option("--flag [flag:boolean]", "Boolean flag", { default: false })
    .parse(Deno.args);

  const app = await createXxx({
    storeMode: options.store,
    port: options.port ? parseInt(options.port) : undefined,
    flag: options.flag,
  });
}
```

## Env var cascade pattern

Priority: **CLI flag > env var > default**

```ts
// Every option follows this shape:
const value = opts.field ??
  Deno.env.get("ENV_VAR") ??
  defaultValue;
```

For boolean flags:
```ts
const DIRECT = opts.direct ??
  Deno.env.get("DIRECT") === "1";
```

## Cliffy Command builder conventions

1. **`.name()` + `.version()`** — always set
2. **`.description()`** — multi-line, lists env vars at end
3. **`.option("--name <type>", "help", { default })`** — typed options with defaults
4. **`.option("--flag [flag:boolean]", "help", { default: false })`** — boolean flags
5. **`.parse(Deno.args)`** — entry point, returns `{ options }`
6. **No `.action()`** — parsed options passed to factory function instead

## Pre-cliffy patterns (legacy)

Manual flag parsing in `xrpc-relay-pds/cli.ts`:
```ts
// Positional flags — no library
const vmName = Deno.args.indexOf('--vm-name') >= 0
  ? Deno.args[Deno.args.indexOf('--vm-name') + 1]
  : 'default-vm';
const noDelete = Deno.args.includes('--no-delete');

// Env var loops (numbered vars)
for (let i = 0; i < 10000; i++) {
  const handle = Deno.env.get(`BIDDER_HANDLE_${i}`);
  if (!handle) break;
  allowlist.push(handle);
}
```

Regex parsing in `qemu/qemu-standalone.ts`:
```ts
function parseDistro(args: string[]): string {
  const distroArg = args.find(a => /^--distro=(.+)$/.test(a));
  return distroArg ? distroArg.match(/^--distro=(.+)$/)![1] : "ubuntu";
}
```

## Module-as-library dual use

Every main.ts follows this structure:
```ts
// 1. Export factory function (library use)
export async function createXxx(opts = {}): Promise<Xxx> { ... }

// 2. CLI guard (script use)
if (import.meta.main) {
  // parse flags → call createXxx() → keep alive
  await new Promise(() => {});
}
```

This lets consumers either:
- Import `createXxx` and embed programmatically
- Run `deno run -A main.ts --flag value` as standalone CLI

## When to use

- Building a standalone CLI tool in Deno
- Need both library and CLI entry point in same file
- Enum-type string options with validation (`"git" | "local" | "pds"`)

## Anti-patterns

- Don't mix cliffy and manual `Deno.args` parsing — pick one
- Don't read env vars inside the factory — pass everything as opts, resolve env in CLI layer
- Don't put business logic in `if (import.meta.main)` block — call the factory function
