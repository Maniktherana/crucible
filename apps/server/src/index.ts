import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixPath } from "./fixPath";
import { createServer } from "./wsServer";

fixPath();

const DEFAULT_PORT = 3773;
const cwd = process.cwd();

async function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      // Preferred port busy — let the OS pick one
      const fallback = net.createServer();
      fallback.listen(0, () => {
        const addr = fallback.address();
        const port =
          typeof addr === "object" && addr !== null ? addr.port : 0;
        fallback.close(() => {
          if (port > 0) resolve(port);
          else reject(new Error("Could not find an available port."));
        });
      });
      fallback.on("error", reject);
    });
  });
}

function resolveStaticDir(): string | undefined {
  // In production, the renderer dist is next to the server dist:
  // apps/server/dist/index.js → apps/renderer/dist/
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rendererDist = path.resolve(__dirname, "../../renderer/dist");

  try {
    const stat = fs.statSync(path.join(rendererDist, "index.html"));
    if (stat.isFile()) return rendererDist;
  } catch {
    // Not found — probably dev mode, Vite will serve
  }

  return undefined;
}

async function main() {
  const port = await findAvailablePort(DEFAULT_PORT);
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const staticDir = devUrl ? undefined : resolveStaticDir();

  if (!devUrl && !staticDir) {
    console.warn(
      "⚠ No built renderer found and no VITE_DEV_SERVER_URL set. The web UI will not be available.",
    );
    console.warn(
      "  Run `bun run --cwd apps/renderer build` or set VITE_DEV_SERVER_URL for dev mode.",
    );
  }

  const server = createServer({ port, cwd, staticDir, devUrl });
  await server.start();

  const url = `http://localhost:${port}`;
  console.log(`\n  ✦ CodeThing running at ${url}`);
  console.log(`  ✦ Project: ${cwd}\n`);

  // Open browser (dynamic import because `open` is ESM-only)
  try {
    const open = await import("open");
    const target = devUrl ?? url;
    await open.default(target);
  } catch {
    console.log(`  Open ${devUrl ?? url} in your browser to get started.\n`);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...\n");
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start CodeThing:", err);
  process.exit(1);
});
