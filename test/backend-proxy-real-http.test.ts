import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import * as nodeFetch from "node-fetch";
import { TextDecoder, TextEncoder } from "node:util";

/**
 * The runtime proxy must be tested against a real HTTP upstream, not only a
 * mocked fetch. node-fetch is a real HTTP client with the same observable
 * behavior that matters here: it decodes gzip bodies but leaves the entity
 * headers on the response object.
 */
Object.assign(globalThis, {
  Headers: nodeFetch.Headers,
  Request: nodeFetch.Request,
  Response: nodeFetch.Response,
  TextDecoder,
  TextEncoder,
});

global.fetch = nodeFetch.default as unknown as typeof globalThis.fetch;

function proxyGet(
  path: string[],
  headers: Record<string, string> = {},
): Promise<nodeFetch.Response> {
  return import("../app/backend-api/[...path]/route").then(({ GET }) =>
    GET(
      new nodeFetch.Request(
        `http://front.test/backend-api/${path.join("/")}`,
        { headers },
      ) as unknown as Request,
      { params: Promise.resolve({ path }) },
    ) as unknown as Promise<nodeFetch.Response>,
  );
}

describe("runtime backend proxy against a real HTTP upstream", () => {
  const originalBackendOrigin = process.env.BACKEND_ORIGIN;
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (originalBackendOrigin === undefined) {
      delete process.env.BACKEND_ORIGIN;
    } else {
      process.env.BACKEND_ORIGIN = originalBackendOrigin;
    }
  });

  async function start(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => unknown,
  ): Promise<void> {
    server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => res.destroy());
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    process.env.BACKEND_ORIGIN = `http://127.0.0.1:${address.port}`;
  }

  test("decodes a compressed upstream and strips stale entity headers", async () => {
    const payload = Buffer.from(
      JSON.stringify({ data: { authenticated: false } }),
    );
    const gz = gzipSync(payload);
    let seenAcceptEncoding: string | null = null;

    await start((req, res) => {
      const value = req.headers["accept-encoding"];
      seenAcceptEncoding = Array.isArray(value)
        ? value.join(", ")
        : (value ?? null);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(gz.length),
      });
      res.end(gz);
    });

    const response = await proxyGet(["auth", "session"], {
      "accept-encoding": "gzip, br",
    });

    expect(seenAcceptEncoding).toBe("identity");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.json()).toEqual({
      data: { authenticated: false },
    });
  });

  test("keeps an uncompressed upstream response intact", async () => {
    const body = JSON.stringify({ data: { authenticated: false } });

    await start((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });

    const response = await proxyGet(["auth", "session"]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.json()).toEqual({
      data: { authenticated: false },
    });
  });

  test("streams SSE chunks before the upstream finishes", async () => {
    let releaseSecond = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    await start(async (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      res.write("event: connected\ndata: {}\n\n");
      await secondGate;
      res.write('event: delta\ndata: {"x":1}\n\n');
      res.end();
    });

    const response = await proxyGet(["requests", "r1", "events"]);
    expect(response.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const body = response.body as unknown as NodeJS.ReadableStream | null;
    expect(body).not.toBeNull();
    try {
      const first = await new Promise<string>((resolve, reject) => {
        body!.once("data", (chunk: unknown) => resolve(String(chunk)));
        body!.once("error", reject);
      });
      expect(first).toContain("event: connected");

      releaseSecond();
      const rest = await new Promise<string>((resolve, reject) => {
        let data = "";
        body!.on("data", (chunk: unknown) => {
          data += String(chunk);
        });
        body!.once("end", () => resolve(data));
        body!.once("error", reject);
      });
      expect(rest).toContain("event: delta");
    } finally {
      releaseSecond();
    }
  }, 5000);
});