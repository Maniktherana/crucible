import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCliOptions } from "./cli";

describe("parseCliOptions", () => {
  it("reads defaults from environment variables", () => {
    const options = parseCliOptions(
      [],
      {
        T3_BACKEND_PORT: "5001",
        T3_WEB_PORT: "5002",
        T3_NO_OPEN: "1",
      },
      "/workspace",
    );

    expect(options.backendPort).toBe(5001);
    expect(options.webPort).toBe(5002);
    expect(options.noOpen).toBe(true);
    expect(options.launchCwd).toBe("/workspace");
  });

  it("allows command line arguments to override defaults", () => {
    const options = parseCliOptions(
      [
        "--backend-port",
        "7001",
        "--web-port=7002",
        "--cwd",
        "apps/t3",
        "--no-open",
      ],
      {},
      "/workspace",
    );

    expect(options.backendPort).toBe(7001);
    expect(options.webPort).toBe(7002);
    expect(options.noOpen).toBe(true);
    expect(options.launchCwd).toBe(path.resolve("apps/t3"));
  });

  it("supports help flag", () => {
    const options = parseCliOptions(["--help"], {}, "/workspace");
    expect(options.showHelp).toBe(true);
  });

  it("throws for unknown arguments", () => {
    expect(() => parseCliOptions(["--wat"], {}, "/workspace")).toThrow(
      "Unknown argument: --wat",
    );
  });
});
