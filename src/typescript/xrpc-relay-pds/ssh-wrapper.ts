#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read --allow-write=/tmp

/**
 * ssh-wrapper.ts — Wrap SSH execution with virtual TTY allocation.
 *
 * When stdin is not a TTY (container, daemon, piped context), allocates a
 * pseudo-terminal so SSH believes it has a controlling terminal. With a TTY
 * present, executes SSH directly.
 *
 * Environment:
 *   SSH_BIN_PATH — path to ssh binary (default: "ssh")
 *
 * PTY allocation tries script(1) first, falls back to python3 pty.spawn(),
 * then to ssh -tt (remote PTY only, no local TTY).
 */

function getSshBin(): string {
  return Deno.env.get("SSH_BIN_PATH") ?? "ssh";
}

function hasTTY(): boolean {
  try {
    return Deno.stdin.isTerminal();
  } catch {
    return false;
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Run SSH directly — used when a TTY is already present. */
async function runDirect(args: string[]): Promise<number> {
  const cmd = new Deno.Command(getSshBin(), {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.spawn().status;
  return code;
}

/** Run SSH under script(1) to allocate a PTY. */
async function runViaScript(args: string[]): Promise<number> {
  const cmdStr = [getSshBin(), ...args].map(shellQuote).join(" ");

  const cmd = new Deno.Command("script", {
    args: [
      "-f",     // flush after each write
      "-q",     // quiet (no start/done messages)
      "-e",     // return child's exit code
      "-c",
      cmdStr,
      "/dev/null", // discard typescript log
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.spawn().status;
  return code;
}

/** Run SSH under python3 pty.spawn() to allocate a PTY. */
async function runViaPython(args: string[]): Promise<number> {
  const sshBin = getSshBin();
  // pty.spawn() forks, creates a PTY, execs the child, and waits.
  // Signal forwarding and exit-code passthrough are handled by pty.spawn.
  const argv = [sshBin, ...args].map((a) => JSON.stringify(a)).join(", ");
  const pythonCode = `import pty, sys; pty.spawn([${argv}])`;

  const cmd = new Deno.Command("python3", {
    args: ["-c", pythonCode],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.spawn().status;
  return code;
}

/** Run SSH with -tt to force remote PTY (no local TTY, but ssh won't complain). */
async function runWithSshTTY(args: string[]): Promise<number> {
  // Prepend -tt before user args (don't add if already present)
  const hasTTYFlag = args.some((a) => a === "-t" || a === "-tt" || a.startsWith("-tt"));
  const finalArgs = hasTTYFlag ? args : ["-tt", ...args];

  const cmd = new Deno.Command(getSshBin(), {
    args: finalArgs,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.spawn().status;
  return code;
}

/** Check if a binary is available on PATH. */
async function commandExists(name: string): Promise<boolean> {
  try {
    const cmd = new Deno.Command("which", { args: [name], stdout: "null", stderr: "null" });
    const { code } = await cmd.output();
    return code === 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = Deno.args;

  // Already have a TTY — run SSH directly
  if (hasTTY()) {
    Deno.exit(await runDirect(args));
  }

  // No TTY — try PTY providers in preference order
  if (await commandExists("script")) {
    Deno.exit(await runViaScript(args));
  }

  if (await commandExists("python3")) {
    Deno.exit(await runViaPython(args));
  }

  // Last resort: ssh -tt (remote PTY, local is still a pipe)
  Deno.exit(await runWithSshTTY(args));
}

main();
