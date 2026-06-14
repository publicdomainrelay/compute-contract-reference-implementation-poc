/**
 * ssh-session-manager.ts — Manages SSH subprocess lifecycles for the XRPC
 * SSH relay. Spawns SSH under script(1) for PTY allocation, exposes
 * readable stdout/stderr streams and a writable stdin sink.
 *
 * Each session is keyed by a UUID. The manager enforces serialised stdin
 * writes and cleans up on process exit.
 */

export interface SshConnectParams {
  host: string;
  port?: number;
  username: string;
  /** Plain-text password (insecure — prefer privateKey). */
  password?: string;
  /** Base64-encoded private key. */
  privateKey?: string;
  /** Remote command to run. Omit for an interactive shell. */
  command?: string;
  /** Extra args passed verbatim to ssh(1). */
  extraArgs?: string[];
}

export interface SshSession {
  readonly sessionId: string;
  readonly params: SshConnectParams;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: WritableStream<Uint8Array>;
  /** Resolves with the exit code when the SSH process terminates. */
  readonly exited: Promise<number>;
  /** Kill the SSH process (SIGKILL). */
  kill(): void;
}

/** Internal state for an active session. */
interface SessionState {
  sessionId: string;
  params: SshConnectParams;
  child: Deno.ChildProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  exited: Promise<number>;
  exitResolve: (code: number) => void;
  killed: boolean;
}

const SSH_BIN_PATH = () => Deno.env.get("SSH_BIN_PATH") ?? "ssh";

// ── PTY helpers ──────────────────────────────────────────────────────────

async function commandExists(name: string): Promise<boolean> {
  try {
    const cmd = new Deno.Command("which", {
      args: [name],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    return code === 0;
  } catch {
    return false;
  }
}

/** Build the ssh(1) argument vector from connection parameters. */
function buildSshArgs(params: SshConnectParams): string[] {
  const args: string[] = [];

  const port = params.port ?? 22;
  args.push("-p", String(port));

  // Disable strict host key checking for programmatic use.
  // Callers who need verification should set extraArgs.
  args.push("-o", "StrictHostKeyChecking=no");
  args.push("-o", "UserKnownHostsFile=/dev/null");
  args.push("-o", "LogLevel=ERROR");

  // Batch mode: never prompt for password interactively
  if (!params.password && !params.privateKey) {
    args.push("-o", "BatchMode=yes");
  }

  if (params.privateKey) {
    // Write key to a temp file and reference it
    // (handled in spawnSession because we need async fs)
  }

  if (params.extraArgs) args.push(...params.extraArgs);

  // user@host
  args.push(`${params.username}@${params.host}`);

  if (params.command) args.push(params.command);

  return args;
}

// ── Session manager ──────────────────────────────────────────────────────

export class SshSessionManager {
  readonly #sessions = new Map<string, SessionState>();

  /** Create an SSH session from connection parameters. */
  async connect(params: SshConnectParams): Promise<SshSession> {
    const sessionId = crypto.randomUUID();

    // Build ssh args once, injecting private-key temp file if provided
    const sshArgs = buildSshArgs(params);

    let keyTempFile: string | undefined;
    if (params.privateKey) {
      const keyBytes = Uint8Array.from(
        atob(params.privateKey),
        (c) => c.charCodeAt(0),
      );
      keyTempFile = await Deno.makeTempFile({ prefix: "ssh-key-" });
      await Deno.writeFile(keyTempFile, keyBytes);
      await Deno.chmod(keyTempFile, 0o600);
      sshArgs.push("-i", keyTempFile);
    }

    // Build the PTY-wrapped command from the (now complete) ssh args
    let cmd: string;
    let args: string[];
    if (await commandExists("script")) {
      const cmdStr = [SSH_BIN_PATH(), ...sshArgs]
        .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
        .join(" ");
      cmd = "script";
      args = ["-fqec", cmdStr, "/dev/null"];
    } else {
      cmd = SSH_BIN_PATH();
      args = ["-tt", ...sshArgs];
    }

    // Spawn
    const child = new Deno.Command(cmd, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Clean up temp key file after spawn (the fd is duplicated into the child)
    if (keyTempFile) {
      // Best-effort cleanup; schedule after a short delay to ensure the
      // child has opened the file.
      setTimeout(async () => {
        try {
          await Deno.remove(keyTempFile!);
        } catch { /* already gone */ }
      }, 1000);
    }

    let exitResolve!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exitResolve = resolve;
    });

    const state: SessionState = {
      sessionId,
      params,
      child,
      stdinWriter: null,
      exited,
      exitResolve,
      killed: false,
    };

    // Background: wait for exit and clean up
    this.#waitForExit(state);

    this.#sessions.set(sessionId, state);

    return {
      sessionId,
      params,
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: new WritableStream<Uint8Array>({
        write: async (chunk) => {
          await this.writeStdin(sessionId, chunk);
        },
        close: async () => {
          await this.closeStdin(sessionId);
        },
      }),
      exited,
      kill: () => this.kill(sessionId),
    };
  }

  /** Write bytes to an SSH session's stdin. */
  async writeStdin(sessionId: string, data: Uint8Array): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error(`Session ${sessionId} not found`);
    if (state.killed) throw new Error(`Session ${sessionId} is closed`);

    let writer = state.stdinWriter;
    if (!writer) {
      writer = state.child.stdin.getWriter();
      state.stdinWriter = writer;
    }
    await writer.write(data);
  }

  /** Close the stdin stream (sends EOF to the remote process). */
  async closeStdin(sessionId: string): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (!state || !state.stdinWriter) return;
    try {
      await state.stdinWriter.close();
    } catch { /* already closed */ }
    state.stdinWriter = null;
  }

  /** Kill an SSH session. */
  kill(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    state.killed = true;
    try {
      state.child.kill("SIGKILL");
    } catch { /* already dead */ }
  }

  /** Get a session by ID (or undefined). */
  get(sessionId: string): SessionState | undefined {
    return this.#sessions.get(sessionId);
  }

  // ── internal ──────────────────────────────────────────────────────────

  async #waitForExit(state: SessionState): Promise<void> {
    try {
      const { code } = await state.child.status;
      state.exitResolve(code);
    } catch {
      state.exitResolve(-1);
    } finally {
      // Clean up stdin writer
      if (state.stdinWriter) {
        try {
          await state.stdinWriter.close();
        } catch { /* ignore */ }
        state.stdinWriter = null;
      }
      // Remove from registry after a short grace period so late writes
      // get a clear "session not found" error instead of hanging.
      setTimeout(() => {
        this.#sessions.delete(state.sessionId);
      }, 5000);
    }
  }
}
