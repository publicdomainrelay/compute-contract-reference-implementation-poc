export function inferFrameType(frame: Record<string, unknown>): string {
  if (frame.repo && frame.seq != null) return "#commit";
  if (frame.name && typeof frame.name === "string") return "#info";
  if (frame.did && frame.active != null) return "#account";
  if (frame.did && frame.handle !== undefined) return "#identity";
  if (frame.did && frame.blocks && !frame.repo) return "#sync";
  return "#unknown";
}

export function summarizeFrame(frame: Record<string, unknown>, type: string): Record<string, unknown> {
  const summary: Record<string, unknown> = { _type: type };
  if (frame.seq != null) summary.seq = frame.seq;
  if (frame.repo) summary.repo = frame.repo;
  if (frame.did) summary.did = frame.did;
  if (frame.rev) summary.rev = frame.rev;
  if (frame.since != null) summary.since = frame.since;
  if (frame.handle) summary.handle = frame.handle;
  if (frame.active != null) summary.active = frame.active;
  if (frame.status) summary.status = frame.status;
  if (frame.name) summary.name = frame.name;
  if (frame.message) summary.message = frame.message;
  if (typeof frame.ops === "number") summary.ops_count = frame.ops;
  if (Array.isArray(frame.ops)) summary.ops_count = frame.ops.length;
  if (typeof frame.blocks === "string" && (frame.blocks as string).length < 100) {
    summary.blocks = (frame.blocks as string).slice(0, 40) + "...";
  }
  return summary;
}
