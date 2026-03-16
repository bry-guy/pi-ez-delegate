export const DELEGATE_TARGETS = ["pane", "window", "session"];

function stripQuotes(token) {
  return token.replace(/^("|')(.*)\1$/, "$2");
}

function tokenize(input) {
  return String(input || "").match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
}

export function normalizeTarget(value) {
  if (!value) return "pane";
  return DELEGATE_TARGETS.includes(value) ? value : "pane";
}

export function parseDelegateCommandInput(input) {
  const tokens = tokenize(input).map(stripQuotes);
  const request = {
    task: "",
    target: "pane",
    name: undefined,
    cwd: undefined,
    createWorktree: true,
    help: false,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      request.help = true;
      continue;
    }
    if (token === "--no-worktree") {
      request.createWorktree = false;
      continue;
    }
    if (token === "--worktree") {
      request.createWorktree = true;
      continue;
    }
    if (token === "--target" && tokens[index + 1]) {
      request.target = normalizeTarget(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("--target=")) {
      request.target = normalizeTarget(token.slice("--target=".length));
      continue;
    }
    if (token === "--name" && tokens[index + 1]) {
      request.name = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith("--name=")) {
      request.name = token.slice("--name=".length);
      continue;
    }
    if (token === "--cwd" && tokens[index + 1]) {
      request.cwd = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      request.cwd = token.slice("--cwd=".length);
      continue;
    }
    request.task += request.task ? ` ${token}` : token;
  }

  return request;
}

export function formatDelegateHelp() {
  return [
    "Usage: /delegate [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] <task>",
    "",
    "Current scaffold status:",
    "- command and tool are registered",
    "- implementation is intentionally deferred",
    "- see doc/plans/pi-ez-delegate-implementation-plan.md",
    "",
    "Examples:",
    "- /delegate implement the GH Actions publish pipeline",
    "- /delegate --target window wire up bot-to-web auth",
    "- /delegate --cwd ~/dev/infra bootstrap Argo CD and Tailscale access",
  ].join("\n");
}

export function formatPlaceholderResult(request) {
  const lines = [
    "pi-ez-delegate is scaffolded but not implemented yet.",
    "",
    `Requested task: ${request.task || "(missing task)"}`,
    `Target mode: ${normalizeTarget(request.target)}`,
    `Create worktree: ${request.createWorktree ? "yes" : "no"}`,
  ];

  if (request.name) lines.push(`Worker name: ${request.name}`);
  if (request.cwd) lines.push(`Worker cwd: ${request.cwd}`);

  lines.push("", "Implementation plan: doc/plans/pi-ez-delegate-implementation-plan.md");
  return lines.join("\n");
}
