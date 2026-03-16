import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  DELEGATE_TARGETS,
  formatDelegateHelp,
  formatPlaceholderResult,
  normalizeTarget,
  parseDelegateCommandInput,
} from "../lib/delegate.js";

const delegateSchema = Type.Object({
  task: Type.String({ description: "Task prompt for the delegated worker" }),
  target: Type.Optional(StringEnum(DELEGATE_TARGETS)),
  name: Type.Optional(Type.String({ description: "Optional human-friendly worker name" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for the delegated worker" })),
  createWorktree: Type.Optional(Type.Boolean({ description: "Create or attach an isolated worktree for same-repo delegation. Defaults to true." })),
});

function filterCompletionItems(prefix, items) {
  const normalized = String(prefix || "").toLowerCase();
  const filtered = items.filter((item) => item.label.toLowerCase().startsWith(normalized));
  return filtered.length > 0 ? filtered : null;
}

function getDelegateArgumentCompletions(prefix) {
  const tokens = String(prefix || "").match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
  const current = /\s$/.test(prefix) ? "" : (tokens.at(-1) ?? "");
  if (!current || current.startsWith("--")) {
    return filterCompletionItems(current, [
      { value: "--target ", label: "--target", description: "Launch worker in a pane, window, or session" },
      { value: "--name ", label: "--name", description: "Set a worker name" },
      { value: "--cwd ", label: "--cwd", description: "Use a different working directory" },
      { value: "--no-worktree", label: "--no-worktree", description: "Skip worktree creation for this delegation" },
      { value: "--worktree", label: "--worktree", description: "Explicitly request a worktree" },
      { value: "--help", label: "--help", description: "Show usage" },
    ]);
  }
  if (tokens.at(-2) === "--target" || current.startsWith("--target=")) {
    const targetPrefix = current.startsWith("--target=") ? current.slice("--target=".length) : current;
    return filterCompletionItems(
      targetPrefix,
      DELEGATE_TARGETS.map((target) => ({
        value: current.startsWith("--target=") ? `--target=${target}` : target,
        label: target,
        description: `Launch worker in a ${target}`,
      })),
    );
  }
  return null;
}

export default function (pi) {
  pi.registerCommand("delegate", {
    description: "Fork the current session into a delegated worker (scaffold placeholder)",
    getArgumentCompletions: getDelegateArgumentCompletions,
    handler: async (args, ctx) => {
      const request = parseDelegateCommandInput(args);
      const text = request.help ? formatDelegateHelp() : formatPlaceholderResult(request);
      if (ctx.hasUI) {
        ctx.ui.notify("pi-ez-delegate scaffold only; see implementation plan", "info");
      }
      pi.sendMessage({
        customType: "pi-ez-delegate",
        content: text,
        display: true,
        details: {
          status: "not-implemented",
          request,
        },
      });
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Fork the current session, optionally create a worktree, and launch a delegated worker in a pane, window, or session.",
    promptSnippet: "Delegate a self-contained task into a forked worker session when work can proceed independently.",
    promptGuidelines: [
      "Use this tool only for independent workstreams with clear file or subsystem ownership.",
      "Default to target pane unless the user explicitly asks for a different launch mode.",
      "Prefer createWorktree=true for same-repo coding work so delegated workers do not collide in the same checkout.",
    ],
    parameters: delegateSchema,
    async execute(_toolCallId, params) {
      const request = {
        task: params.task,
        target: normalizeTarget(params.target),
        name: params.name,
        cwd: params.cwd,
        createWorktree: params.createWorktree ?? true,
      };
      return {
        content: [{ type: "text", text: formatPlaceholderResult(request) }],
        details: {
          status: "not-implemented",
          request,
        },
      };
    },
  });

  pi.registerMessageRenderer("pi-ez-delegate", (message, options, theme) => {
    let text = theme.fg("accent", "[pi-ez-delegate] ");
    text += String(message.content);
    if (options.expanded && message.details) {
      text += "\n\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
    }
    return new Text(text, 0, 0);
  });
}
