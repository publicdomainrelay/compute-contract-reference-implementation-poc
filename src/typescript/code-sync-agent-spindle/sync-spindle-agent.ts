#!/usr/bin/env -S deno run --allow-all

/**
 * sync-spindle-agent.ts
 *
 * Two-agent system using the Claude Code Agent SDK with structured outputs.
 *
 * Agent 1 — Analysis Subagent
 *   A focused read-only agent that compares core/spindle/ (Go) with the
 *   TypeScript/Deno reference implementation and returns a validated
 *   AnalysisResult via outputFormat.
 *
 * Agent 2 — Main Agent
 *   Receives the AnalysisResult, applies required changes on a new git branch
 *   inside the submodule, commits, and returns a validated FinalReport via
 *   outputFormat.  Also defines a 'ts-reader' subagent (via the agents
 *   parameter) that it invokes to understand TypeScript file structure before
 *   making edits.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=<key> deno run --allow-all sync-spindle-agent.ts
 *
 * The final JSON report is written to stdout; progress messages go to stderr.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

// ── Path constants ─────────────────────────────────────────────────────────────

const REPO_ROOT = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
// SUBMODULE_ROOT is a separate git repository nested inside REPO_ROOT.
// All TypeScript changes, branch creation, and commits happen inside it.
const SUBMODULE_ROOT = `${REPO_ROOT}/compute-contract-reference-implementation-poc`;
const CORE_SPINDLE = `${REPO_ROOT}/core/spindle`;
const TS_SPINDLE = `${SUBMODULE_ROOT}/src/typescript/spindle`;

// Git identity used in all commits produced by this script.
const GIT_AUTHOR = `-c user.email="sync-agent@spindle.dev" -c user.name="Spindle Sync Agent"`;

// ── JSON Schemas ───────────────────────────────────────────────────────────────
//
// These objects are passed directly to outputFormat.schema.  The SDK validates
// agent output against them and will re-prompt on mismatch.

const relevantChangeSchema = {
  type: "object",
  properties: {
    concept: {
      type: "string",
      description: "Feature or concept that differs between the Go and TypeScript implementations",
    },
    core_file: {
      type: "string",
      description: "Relative path to the Go source file (from repo root)",
    },
    description: {
      type: "string",
      description: "What exists / changed in the Go implementation",
    },
    typescript_impact: {
      type: "string",
      description: "How this gap affects the TypeScript spindle",
    },
    typescript_file: {
      type: "string",
      description: "Relative path to the TypeScript file that needs updating (from repo root)",
    },
    changes_needed: {
      type: "string",
      description: "Specific, actionable changes to apply in the TypeScript file",
    },
  },
  required: [
    "concept",
    "core_file",
    "description",
    "typescript_impact",
    "typescript_file",
    "changes_needed",
  ],
};

// Schema for Agent 1's structured output
const analysisSchema = {
  type: "object",
  properties: {
    recent_core_commits: {
      type: "array",
      items: { type: "string" },
      description: "Recent git commits that touched core/spindle/ (one-line format)",
    },
    core_files_analyzed: {
      type: "array",
      items: { type: "string" },
      description: "Go source files that were read and analyzed",
    },
    ts_files_analyzed: {
      type: "array",
      items: { type: "string" },
      description: "TypeScript source files that were read and analyzed",
    },
    is_relevant: {
      type: "boolean",
      description:
        "True when gaps between Go and TypeScript require TypeScript updates",
    },
    relevant_changes: {
      type: "array",
      items: relevantChangeSchema,
      description:
        "Changes needed in the TypeScript spindle (empty array when is_relevant is false)",
    },
    no_changes_reason: {
      type: "string",
      description:
        "Explanation of why no changes are needed (populated when is_relevant is false)",
    },
    analysis_summary: {
      type: "string",
      description: "Concise summary of findings — what was compared and what gaps were found",
    },
  },
  required: [
    "recent_core_commits",
    "core_files_analyzed",
    "ts_files_analyzed",
    "is_relevant",
    "relevant_changes",
    "analysis_summary",
  ],
};

// Tracks what the main agent actually did (separate from the analysis)
const changeAppliedSchema = {
  type: "object",
  properties: {
    typescript_file: {
      type: "string",
      description: "File that was modified",
    },
    description: {
      type: "string",
      description: "What was actually changed in this file",
    },
  },
  required: ["typescript_file", "description"],
};

// Schema for Agent 2's structured output
const finalReportSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["changes_made", "no_changes_needed"],
      description: "Outcome of the synchronisation run",
    },
    analysis: analysisSchema,
    changes_applied: {
      type: "array",
      items: changeAppliedSchema,
      description:
        "What the main agent actually changed — separate from the analysis plan. " +
        "Present only when status is 'changes_made'.",
    },
    commit: {
      type: "object",
      properties: {
        branch: {
          type: "string",
          description: "Submodule branch name created for the changes",
        },
        commit_hash: {
          type: "string",
          description:
            "Exact 40-character SHA-1 copied verbatim from `git rev-parse HEAD` output",
        },
        commit_message: {
          type: "string",
          description: "Commit message used",
        },
        files_modified: {
          type: "array",
          items: { type: "string" },
          description: "Submodule-relative paths of files included in the commit",
        },
      },
      required: ["branch", "commit_hash", "commit_message", "files_modified"],
      description: "Commit details — present only when status is 'changes_made'",
    },
    no_changes_report: {
      type: "string",
      description:
        "Human-readable explanation of what was analyzed and why no changes were needed",
    },
  },
  required: ["status", "analysis"],
};

// ── TypeScript types (mirror the schemas above) ───────────────────────────────

interface RelevantChange {
  concept: string;
  core_file: string;
  description: string;
  typescript_impact: string;
  typescript_file: string;
  changes_needed: string;
}

interface AnalysisResult {
  recent_core_commits: string[];
  core_files_analyzed: string[];
  ts_files_analyzed: string[];
  is_relevant: boolean;
  relevant_changes: RelevantChange[];
  no_changes_reason?: string;
  analysis_summary: string;
}

interface FinalReport {
  status: "changes_made" | "no_changes_needed";
  analysis: AnalysisResult;
  changes_applied?: Array<{ typescript_file: string; description: string }>;
  commit?: {
    branch: string;
    commit_hash: string;
    commit_message: string;
    files_modified: string[];
  };
  no_changes_report?: string;
}

// ── Agent 1: Analysis Subagent ─────────────────────────────────────────────────
//
// Read-only agent. Inspects git history, reads Go and TypeScript sources, then
// returns a structured AnalysisResult via outputFormat.

async function runAnalysisAgent(): Promise<AnalysisResult> {
  console.error("[analysis-agent] Comparing core/spindle with TypeScript spindle...");

  for await (
    const message of query({
      prompt: `You are a code analysis specialist comparing two implementations of the Spindle server.

Determine whether gaps between the Go implementation and the TypeScript/Deno reference
implementation require TypeScript updates.

LOCATIONS
  Go implementation   : ${CORE_SPINDLE}/
  TypeScript impl     : ${TS_SPINDLE}/

STEPS TO FOLLOW

1. Inspect git history for the Go spindle:
     git -C ${REPO_ROOT} log --oneline -20 -- core/spindle/

   For any recent commits, examine what changed:
     git -C ${REPO_ROOT} show --stat <hash>
     git -C ${REPO_ROOT} diff <hash>^ <hash> -- core/spindle/

2. Read the Go source files (use Glob to discover all .go files, then read key ones):
     ${CORE_SPINDLE}/server.go
     ${CORE_SPINDLE}/ingester.go
     ${CORE_SPINDLE}/config/config.go
     ${CORE_SPINDLE}/xrpc/xrpc.go
     ${CORE_SPINDLE}/xrpc/add_secret.go
     ${CORE_SPINDLE}/xrpc/remove_secret.go
     ${CORE_SPINDLE}/xrpc/list_secrets.go
     ${CORE_SPINDLE}/xrpc/pipeline_cancel_pipeline.go
     ${CORE_SPINDLE}/db/db.go
     ${CORE_SPINDLE}/secrets/manager.go
     ${CORE_SPINDLE}/models/pipeline.go
     ${CORE_SPINDLE}/models/pipeline_env.go

3. Read the TypeScript source files:
     ${TS_SPINDLE}/main.ts
     ${TS_SPINDLE}/marketRFP.ts
     ${TS_SPINDLE}/deno.json

4. Compare the two implementations along these dimensions:
   - HTTP endpoints / XRPC routes present in Go but missing or outdated in TypeScript
   - Pipeline or job handling logic that has changed in Go
   - Secret management patterns that differ
   - ATProto / Lexicon integration differences
   - Environment variable injection logic (especially pipeline_env.go)
   - Configuration fields that Go exposes but TypeScript lacks
   - Any other behaviourally meaningful differences

5. Set is_relevant = true if any Go behaviour needs a TypeScript counterpart.
   Populate relevant_changes with specific, actionable items.
   If is_relevant = false, explain why in no_changes_reason.

analysis_summary must describe ONLY what you observed — not what was applied.
Return a structured JSON report matching the provided schema exactly.`,
      options: {
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        outputFormat: {
          type: "json_schema",
          schema: analysisSchema,
        },
      },
    })
  ) {
    if (message.type === "result") {
      if (message.subtype === "success" && message.structured_output) {
        console.error("[analysis-agent] Complete.");
        return message.structured_output as AnalysisResult;
      }
      if (message.subtype === "error_max_structured_output_retries") {
        throw new Error(
          "[analysis-agent] Exceeded structured output retry limit — check schema complexity",
        );
      }
    }
  }

  throw new Error("[analysis-agent] Agent loop ended without producing a result");
}

// ── Agent 2: Main Agent ────────────────────────────────────────────────────────
//
// Receives the structured analysis from Agent 1.  If changes are needed it:
//   1. Uses the 'ts-reader' subagent to understand TypeScript files before editing.
//   2. Creates a git branch INSIDE the submodule, applies changes, and commits.
//   3. Updates the outer repo's submodule pointer.
// Either way it returns a structured FinalReport via outputFormat.

async function runMainAgent(analysis: AnalysisResult): Promise<FinalReport> {
  console.error(
    `[main-agent] is_relevant=${analysis.is_relevant}  ` +
      `pending_changes=${analysis.relevant_changes.length}`,
  );

  const analysisJson = JSON.stringify(analysis, null, 2);

  const prompt = analysis.is_relevant
    ? `You are a code synchronisation agent. Apply the changes identified by the analysis
agent to the TypeScript/Deno spindle reference implementation.

ANALYSIS REPORT (read-only — copy this unchanged into the 'analysis' field of your output)
${analysisJson}

REPOSITORY LAYOUT — IMPORTANT
  Outer repo root : ${REPO_ROOT}/
  Submodule root  : ${SUBMODULE_ROOT}/   ← this is a SEPARATE git repository
  TypeScript files: ${TS_SPINDLE}/

All branch creation, file edits, staging, and commits for TypeScript changes
happen INSIDE the submodule (${SUBMODULE_ROOT}/), not in the outer repo.

GIT IDENTITY — include these flags on every git commit command:
  ${GIT_AUTHOR}

WORKFLOW

1. For each distinct typescript_file in relevant_changes, use the 'ts-reader' subagent
   to understand the file's current structure before editing. Example:
     "Use the ts-reader agent to read ${TS_SPINDLE}/main.ts and summarise its HTTP routes"
   Do this for every distinct typescript_file before you start editing.

2. Create a timestamped branch INSIDE the submodule:
     git -C ${SUBMODULE_ROOT} checkout -b sync/spindle-$(date +%Y%m%d-%H%M%S)

3. Apply every item in relevant_changes to its typescript_file.
   Translate Go patterns to idiomatic TypeScript/Deno (Hono for HTTP routing).
   Keep changes minimal and faithful to the analysis.

4. Stage and commit INSIDE the submodule:
     git -C ${SUBMODULE_ROOT} add src/typescript/spindle/main.ts src/typescript/spindle/marketRFP.ts
     git -C ${SUBMODULE_ROOT} diff --cached --name-only
     git ${GIT_AUTHOR} -C ${SUBMODULE_ROOT} commit -m "sync(spindle): <concise description>

<detailed bullet list of each change made>"

   ⚠️  IMMEDIATELY after the commit, run:
         git -C ${SUBMODULE_ROOT} rev-parse HEAD
   Copy the EXACT 40-character hex string from that output and use it verbatim
   as commit_hash in your structured output. Never invent, truncate, or zero-fill
   this value. If it does not look like a valid SHA-1, something went wrong.

5. Update the outer repo's submodule pointer:
     git -C ${REPO_ROOT} add compute-contract-reference-implementation-poc
     git ${GIT_AUTHOR} -C ${REPO_ROOT} commit -m "sync(spindle): update submodule pointer"

6. Return the FinalReport:
   - status          : "changes_made"
   - analysis        : copy the ANALYSIS REPORT above unchanged (do NOT rewrite any field)
   - changes_applied : describe what you actually did per file (separate from the analysis plan)
   - commit.branch         : the submodule branch name from step 2
   - commit.commit_hash    : the exact 40-char SHA from step 4
   - commit.commit_message : the full commit message used in step 4
   - commit.files_modified : list of submodule-relative paths staged in step 4`
    : `The analysis agent confirmed that NO changes are needed in the TypeScript spindle.

ANALYSIS REPORT (copy unchanged into the 'analysis' field of your output)
${analysisJson}

Return a FinalReport with:
  status            : "no_changes_needed"
  analysis          : the ANALYSIS REPORT above, copied unchanged
  no_changes_report : a clear, detailed explanation of what was checked and why
                      the TypeScript implementation is already consistent with Go`;

  for await (
    const message of query({
      prompt,
      options: {
        allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Agent"],
        agents: {
          "ts-reader": {
            description:
              "Read and summarise TypeScript/Deno source files in the spindle implementation. " +
              "Invoke before editing main.ts, marketRFP.ts, or deno.json to understand their " +
              "current structure, exports, and conventions.",
            prompt: `You are a TypeScript code analyst specialising in Deno and Hono applications.
When asked to read a file, return a concise but complete structured summary covering:

- HTTP route handlers: method, path, handler behaviour
- Key exported functions and their signatures
- Important interfaces and type definitions
- ATProto / Lexicon integration points
- Environment variables and configuration values read at startup
- Any conventions or patterns a future editor should respect

Be thorough enough that the caller can plan accurate edits without re-reading the file.`,
            tools: ["Read", "Grep", "Glob"],
          },
        },
        outputFormat: {
          type: "json_schema",
          schema: finalReportSchema,
        },
      },
    })
  ) {
    if (message.type === "result") {
      if (message.subtype === "success" && message.structured_output) {
        console.error("[main-agent] Complete.");
        return message.structured_output as FinalReport;
      }
      if (message.subtype === "error_max_structured_output_retries") {
        throw new Error(
          "[main-agent] Exceeded structured output retry limit — check schema complexity",
        );
      }
    }
  }

  throw new Error("[main-agent] Agent loop ended without producing a result");
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateReport(report: FinalReport): void {
  if (report.status === "changes_made") {
    if (!report.commit) {
      throw new Error("Report status is 'changes_made' but no commit field is present");
    }
    const sha = report.commit.commit_hash;
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(
        `commit_hash "${sha}" is not a valid 40-character SHA-1. ` +
          "The agent likely hallucinated this value instead of running `git rev-parse HEAD`.",
      );
    }
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  try {
    // Phase 1 — analysis subagent produces a structured AnalysisResult
    const analysis = await runAnalysisAgent();

    // Phase 2 — main agent acts on the analysis and produces a structured FinalReport
    const report = await runMainAgent(analysis);

    // Validate before trusting the report (catches hallucinated commit hashes)
    validateReport(report);

    // Final JSON to stdout; all progress messages went to stderr
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
