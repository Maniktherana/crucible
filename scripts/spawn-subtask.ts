#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPTS_DIR = Path.dirname(fileURLToPath(import.meta.url));

type SpawnSubtaskOptions = {
  readonly prompt: string;
  readonly directory: string;
  readonly title?: string;
  readonly expectedFilePath?: string;
  readonly expectedText?: string;
  readonly parentRunId?: string;
  readonly origin?: string;
  readonly baseDir?: string;
  readonly token?: string;
  readonly repo?: string;
};

const argv = parseArgs({
  options: {
    prompt: { type: "string" },
    directory: { type: "string" },
    title: { type: "string" },
    "expected-file": { type: "string" },
    "expected-text": { type: "string" },
    "parent-run-id": { type: "string" },
    origin: { type: "string" },
    "base-dir": { type: "string" },
    token: { type: "string" },
    repo: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  spawn-subtask [--origin <url>] [--base-dir <path>] [--token <bearer>] [--directory <dir>] [--title <title>] [--expected-file <path>] [--expected-text <text>] [--parent-run-id <id>] [--repo <owner/name>] <prompt...>",
      "",
      "Environment:",
      "  T3CODE_SERVER_ORIGIN   Explicit Crucible server origin.",
      "  T3CODE_BEARER_TOKEN    Bearer token for authenticated Crucible requests.",
      "  T3CODE_HOME            Used to discover the local server-runtime.json file.",
    ].join("\n"),
  );
}

async function readJsonIfExists(filePath: string): Promise<{ readonly origin?: string } | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { readonly origin?: unknown };
    if (typeof parsed.origin === "string" && parsed.origin.trim().length > 0) {
      return { origin: parsed.origin.trim() };
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolveOrigin(options: SpawnSubtaskOptions): Promise<string> {
  const explicitOrigin = options.origin?.trim() || process.env.T3CODE_SERVER_ORIGIN?.trim();
  if (explicitOrigin) {
    return explicitOrigin;
  }

  const baseDir = options.baseDir?.trim() || process.env.T3CODE_HOME?.trim();
  const candidates = [...(baseDir ? [baseDir] : []), Path.join(OS.homedir(), ".t3")];

  for (const root of candidates) {
    for (const candidate of [
      Path.join(root, "dev", "server-runtime.json"),
      Path.join(root, "userdata", "server-runtime.json"),
    ]) {
      const state = await readJsonIfExists(candidate);
      if (state?.origin) {
        return state.origin;
      }
    }
  }

  throw new Error(
    "Unable to resolve the Crucible server origin. Pass --origin or set T3CODE_SERVER_ORIGIN/T3CODE_HOME.",
  );
}

async function readParentRunIdFromDirectory(directory: string): Promise<string | undefined> {
  try {
    const raw = await readFile(Path.join(directory, ".crucible-run-id"), "utf8");
    const runId = raw.trim();
    return runId.length > 0 ? runId : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function buildDefaultDirectory(baseDirectory: string): string {
  return Path.join(baseDirectory, ".crucible-subtasks", randomUUID().slice(0, 8));
}

function getPrompt(positionals: ReadonlyArray<string>, promptFlag: string | undefined): string {
  const prompt = (promptFlag ?? positionals.join(" ")).trim();
  if (prompt.length === 0) {
    throw new Error("A prompt is required.");
  }
  return prompt;
}

async function main(): Promise<void> {
  if (argv.values.help) {
    printUsage();
    return;
  }

  // Use SCRIPTS_DIR so the path is portable (not hardcoded to a developer machine)
  void SCRIPTS_DIR;

  const prompt = getPrompt(argv.positionals, argv.values.prompt);
  const parentRunId =
    argv.values["parent-run-id"]?.trim() ||
    process.env.CRUCIBLE_PARENT_RUN_ID?.trim() ||
    (await readParentRunIdFromDirectory(process.cwd()));
  const directory = argv.values.directory?.trim() || buildDefaultDirectory(process.cwd());
  const repo = argv.values.repo?.trim() || process.env.CRUCIBLE_REPO?.trim();
  const options: SpawnSubtaskOptions = {
    prompt,
    directory,
    ...(argv.values.title ? { title: argv.values.title.trim() } : {}),
    ...(argv.values["expected-file"]
      ? { expectedFilePath: argv.values["expected-file"].trim() }
      : {}),
    ...(argv.values["expected-text"] ? { expectedText: argv.values["expected-text"].trim() } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    ...(argv.values.origin ? { origin: argv.values.origin.trim() } : {}),
    ...(argv.values["base-dir"] ? { baseDir: argv.values["base-dir"].trim() } : {}),
    ...(argv.values.token
      ? { token: argv.values.token.trim() }
      : process.env.T3CODE_BEARER_TOKEN?.trim()
        ? { token: process.env.T3CODE_BEARER_TOKEN.trim() }
        : {}),
    ...(repo ? { repo } : {}),
  };

  const origin = await resolveOrigin(options);
  const response = await fetch(`${origin}/api/crucible/runs`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      directory: options.directory,
      title: options.title,
      prompt: options.prompt,
      expectedFilePath: options.expectedFilePath,
      expectedText: options.expectedText,
      parentRunId: options.parentRunId,
      repo: options.repo,
      spawnCommand: "spawn-subtask",
      spawnTool: "bash",
      spawnNote: "spawn-subtask CLI",
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text.trim().length > 0 ? text : `Request failed with ${response.status}`);
  }

  const payload = text.trim().length > 0 ? JSON.parse(text) : null;
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
