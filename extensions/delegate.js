import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  DELEGATE_COMMAND,
  DELEGATE_MESSAGE_TYPE,
  DELEGATE_REGISTRY_ENTRY_TYPE,
  DELEGATE_TARGETS,
  delegateTask,
  formatDelegateHelp,
  formatDelegateLaunchResult,
  getForkBranchEntries,
  getParentEffectiveCwd,
  parseDelegateCommandInput,
} from "../lib/delegate.js";

const delegateSchema = Type.Object({
  task: Type.String({ description: "Task prompt for the delegated worker" }),
  target: Type.Optional(StringEnum(DELEGATE_TARGETS)),
  name: Type.Optional(Type.String({ description: "Optional human-friendly worker name" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for the delegated worker" })),
  createWorktree: Type.Optional(
    Type.Boolean({ description: "Create an isolated worktree for same-repo delegation. Defaults to true." }),
  ),
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

function buildRuntimeContext(ctx, rawBranchEntries, options = {}) {
  const parentCwd = getParentEffectiveCwd(ctx.cwd, rawBranchEntries);
  return {
    parentCwd,
    parentSessionFile: ctx.sessionManager.getSessionFile(),
    headerVersion: ctx.sessionManager.getHeader()?.version,
    branchEntries: getForkBranchEntries(rawBranchEntries, {
      excludeTrailingDelegateToolCall: options.excludeTrailingDelegateToolCall,
    }),
    getLabel: (entryId) => ctx.sessionManager.getLabel(entryId),
    env: process.env,
    piCommand: process.env.PI_EZ_DELEGATE_PI_COMMAND || "pi",
  };
}

function sendDelegateMessage(pi, content, details) {
  pi.sendMessage({
    customType: DELEGATE_MESSAGE_TYPE,
    content,
    display: true,
    details,
  });
}

export default function delegateExtension(pi) {
  pi.registerCommand(DELEGATE_COMMAND, {
    description: "Fork the current session into a tmux worker, with same-repo worktrees by default",
    getArgumentCompletions: getDelegateArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseDelegateCommandInput(args);
      if (parsed.request.help) {
        sendDelegateMessage(pi, formatDelegateHelp(), { status: "help" });
        return;
      }
      if (parsed.errors.length > 0) {
        const content = [`/${DELEGATE_COMMAND} could not parse the request.`, "", ...parsed.errors, "", formatDelegateHelp()].join("\n");
        if (ctx.hasUI) ctx.ui.notify(parsed.errors[0], "error");
        sendDelegateMessage(pi, content, { status: "error", errors: parsed.errors });
        return;
      }

      await ctx.waitForIdle();

      const rawBranchEntries = ctx.sessionManager.getBranch();
      try {
        const result = await delegateTask(parsed.request, buildRuntimeContext(ctx, rawBranchEntries));
        pi.appendEntry(DELEGATE_REGISTRY_ENTRY_TYPE, result);
        if (ctx.hasUI) ctx.ui.notify(`Launched ${result.worker.name} in tmux ${result.launch.mode}`, "success");
        sendDelegateMessage(pi, formatDelegateLaunchResult(result), result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        sendDelegateMessage(pi, message, { status: "error" });
      }
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Fork the current session, optionally create a same-repo worktree, and launch a delegated worker in tmux.",
    promptSnippet: "Delegate an independent task into a forked tmux worker session.",
    promptGuidelines: [
      "Use this tool only for independent workstreams with clear ownership boundaries.",
      "Default to target pane unless the user explicitly asks for a different tmux target.",
      "Prefer createWorktree=true for same-repo coding work so delegated workers do not collide in the same checkout.",
      `The user-facing slash command is /${DELEGATE_COMMAND}.`,
    ],
    parameters: delegateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rawBranchEntries = ctx.sessionManager.getBranch();
      const result = await delegateTask(
        {
          task: params.task,
          target: params.target,
          name: params.name,
          cwd: params.cwd,
          createWorktree: params.createWorktree ?? true,
        },
        buildRuntimeContext(ctx, rawBranchEntries, { excludeTrailingDelegateToolCall: true }),
      );

      pi.appendEntry(DELEGATE_REGISTRY_ENTRY_TYPE, result);

      return {
        content: [{ type: "text", text: formatDelegateLaunchResult(result) }],
        details: result,
      };
    },
  });

  pi.registerMessageRenderer(DELEGATE_MESSAGE_TYPE, (message, options, theme) => {
    const status = message.details?.status;
    const color = status === "error" ? "error" : status === "success" ? "success" : "accent";
    let text = theme.fg(color, `[${DELEGATE_COMMAND}] `) + String(message.content);
    if (options.expanded && message.details) {
      text += "\n\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
    }
    return new Text(text, 0, 0);
  });
}
