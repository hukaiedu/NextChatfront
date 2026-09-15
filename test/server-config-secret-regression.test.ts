import { jest } from "@jest/globals";
import { Headers, Request, Response } from "node-fetch";
import { TextDecoder, TextEncoder } from "node:util";

const SECRET_SENTINEL = "PERSONCHAT_D1A_SECRET_SENTINEL_9f7e2c";

describe("server provider key secret regression", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: `KEY_A,${SECRET_SENTINEL},KEY_C`,
    };
    jest.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  test("keeps deterministic key selection without exposing the selected secret", async () => {
    const captured: unknown[][] = [];
    const consoleMethods = ["log", "info", "warn", "error"] as const;
    for (const method of consoleMethods) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args);
      });
    }

    const { getServerSideConfig } = await import("../app/config/server");
    const serverConfig = getServerSideConfig();

    expect(serverConfig.apiKey).toBe(SECRET_SENTINEL);

    Object.assign(globalThis, {
      Headers,
      Request,
      Response,
      TextDecoder,
      TextEncoder,
    });
    const { GET } = await import("../app/api/config/route");
    const publicResponse = await GET();
    const publicConfig = await publicResponse.json();
    const capturedText = JSON.stringify(captured);
    const publicText = JSON.stringify(publicConfig);

    expect(capturedText).not.toContain(SECRET_SENTINEL);
    expect(publicText).not.toContain(SECRET_SENTINEL);
    expect(capturedText.split(SECRET_SENTINEL).length - 1).toBe(0);
    expect(publicText.split(SECRET_SENTINEL).length - 1).toBe(0);
  });
});
