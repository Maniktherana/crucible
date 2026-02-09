#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRuntimeApiServer } from "./runtimeApiServer";

const DEFAULT_BACKEND_PORT = 4317;
const DEFAULT_WEB_PORT = 4318;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

interface CliOptions {
  backendPort: number;
  webPort: number;
  launchCwd: string;
  noOpen: boolean;
  showHelp: boolean;
}

function readArgValue(args: string[], index: number, key: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${key}.`);
  }

  return value;
}

export function parseCliOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): CliOptions {
  let backendPort = parsePort(env.T3_BACKEND_PORT, DEFAULT_BACKEND_PORT);
  let webPort = parsePort(env.T3_WEB_PORT, DEFAULT_WEB_PORT);
  let launchCwd = cwd;
  let noOpen = env.T3_NO_OPEN === "1";
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }

    if (arg.startsWith("--backend-port=")) {
      backendPort = parsePort(arg.split("=")[1], DEFAULT_BACKEND_PORT);
      continue;
    }

    if (arg === "--backend-port") {
      backendPort = parsePort(
        readArgValue(argv, index, "--backend-port"),
        DEFAULT_BACKEND_PORT,
      );
      index += 1;
      continue;
    }

    if (arg.startsWith("--web-port=")) {
      webPort = parsePort(arg.split("=")[1], DEFAULT_WEB_PORT);
      continue;
    }

    if (arg === "--web-port") {
      webPort = parsePort(readArgValue(argv, index, "--web-port"), DEFAULT_WEB_PORT);
      index += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      launchCwd = path.resolve(arg.split("=")[1] ?? cwd);
      continue;
    }

    if (arg === "--cwd") {
      launchCwd = path.resolve(readArgValue(argv, index, "--cwd"));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    backendPort,
    webPort,
    launchCwd,
    noOpen,
    showHelp,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: t3 [options]",
      "",
      "Options:",
      "  --no-open               Start runtime without opening browser",
      "  --backend-port <port>   Override WebSocket API port (default: 4317)",
      "  --web-port <port>       Override web UI port (default: 4318)",
      "  --cwd <path>            Launch project directory (default: current directory)",
      "  -h, --help              Show this help message",
      "",
      "Environment variables:",
      "  T3_NO_OPEN=1            Disable browser auto-open",
      "  T3_BACKEND_PORT=<port>  Default backend port",
      "  T3_WEB_PORT=<port>      Default web UI port",
      "",
    ].join("\n"),
  );
}

function openBrowser(url: string, noOpen: boolean): void {
  if (noOpen) {
    return;
  }

  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Best-effort browser launch; keep runtime alive even when opener is unavailable.
  });
  child.unref();
}

function ensureRendererBuild(rendererRoot: string): void {
  const distPath = path.join(rendererRoot, "dist", "index.html");
  if (fs.existsSync(distPath)) {
    return;
  }

  const bunPath = process.env.BUN_BIN ?? "bun";
  const build = spawnSync(bunPath, ["run", "--cwd", rendererRoot, "build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
    },
  });
  if (build.status !== 0) {
    throw new Error("Failed to build renderer assets.");
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

function startStaticWebServer(distRoot: string, port: number) {
  const server = createServer((request, response) => {
    const requestPath = request.url ? request.url.split("?")[0] : "/";
    const normalized =
      requestPath === "/" ? "index.html" : (requestPath ?? "/").replace(/^\/+/, "");
    const safePath = path.normalize(normalized).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(distRoot, safePath);

    if (!filePath.startsWith(distRoot)) {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }

    const exists = fs.existsSync(filePath);
    const targetPath = exists ? filePath : path.join(distRoot, "index.html");
    fs.readFile(targetPath, (error, content) => {
      if (error) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypeFor(targetPath));
      response.end(content);
    });
  });

  return new Promise<{
    close: () => Promise<void>;
  }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: async () => {
          await new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          });
        },
      });
    });
  });
}

async function main() {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2), process.env, process.cwd());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments."}\n\n`);
    printHelp();
    process.exit(1);
    return;
  }

  if (options.showHelp) {
    printHelp();
    process.exit(0);
    return;
  }

  const runtimeServer = await startRuntimeApiServer({
    port: options.backendPort,
    launchCwd: options.launchCwd,
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rendererRoot = path.resolve(__dirname, "../../renderer");
  ensureRendererBuild(rendererRoot);
  const staticServer = await startStaticWebServer(path.join(rendererRoot, "dist"), options.webPort);

  const wsParam = encodeURIComponent(runtimeServer.wsUrl);
  const appUrl = `http://127.0.0.1:${options.webPort}?ws=${wsParam}`;
  openBrowser(appUrl, options.noOpen);

  process.stdout.write(`CodeThing is running at ${appUrl}\n`);

  const shutdown = async () => {
    await Promise.all([staticServer.close(), runtimeServer.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

const entrypoint = process.argv[1];
const currentFilePath = fileURLToPath(import.meta.url);
if (entrypoint && path.resolve(entrypoint) === currentFilePath) {
  void main();
}
