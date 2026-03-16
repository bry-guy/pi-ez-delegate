import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import {
  DELEGATE_DEFAULT_CONFIG,
  getDefaultConfigPath,
  loadDelegateConfig,
  normalizeDelegateConfig,
} from "../lib/config.js";

test("normalizeDelegateConfig fills defaults", () => {
  assert.deepEqual(normalizeDelegateConfig({}), DELEGATE_DEFAULT_CONFIG);
});

test("loadDelegateConfig returns defaults when the config file is missing", async () => {
  const tempAgentDir = await mkdtemp(join(os.tmpdir(), "ezdg-config-"));

  try {
    const result = await loadDelegateConfig({ agentDir: tempAgentDir });

    assert.equal(result.exists, false);
    assert.equal(result.configPath, getDefaultConfigPath(tempAgentDir));
    assert.deepEqual(result.fileConfig, {});
    assert.deepEqual(result.config, DELEGATE_DEFAULT_CONFIG);
  } finally {
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});

test("loadDelegateConfig reads and normalizes a config file", async () => {
  const tempAgentDir = await mkdtemp(join(os.tmpdir(), "ezdg-config-"));
  const configPath = getDefaultConfigPath(tempAgentDir);

  try {
    await writeFile(
      configPath,
      `${JSON.stringify({
        multiplexer: "zellij",
        defaultTarget: "window",
        defaultPaneSplit: "vertical",
        minPaneColumns: 240,
        minPaneRows: 32,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await loadDelegateConfig({ agentDir: tempAgentDir });

    assert.equal(result.exists, true);
    assert.deepEqual(result.config, {
      multiplexer: "zellij",
      defaultTarget: "window",
      defaultPaneSplit: "vertical",
      minPaneColumns: 240,
      minPaneRows: 32,
    });
  } finally {
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});

test("loadDelegateConfig rejects invalid config values", async () => {
  const tempAgentDir = await mkdtemp(join(os.tmpdir(), "ezdg-config-"));
  const configPath = getDefaultConfigPath(tempAgentDir);

  try {
    await writeFile(configPath, `${JSON.stringify({ defaultPaneSplit: "diagonal" })}\n`, "utf8");

    await assert.rejects(
      () => loadDelegateConfig({ agentDir: tempAgentDir }),
      /defaultPaneSplit must be one of: auto, horizontal, vertical\./,
    );
  } finally {
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});
