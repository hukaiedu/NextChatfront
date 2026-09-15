import { jest } from "@jest/globals";
import * as nodeFetch from "node-fetch";
import { TextDecoder, TextEncoder } from "node:util";

Object.assign(globalThis, {
  Headers: nodeFetch.Headers,
  Request: nodeFetch.Request,
  Response: nodeFetch.Response,
  TextDecoder,
  TextEncoder,
});

describe("runtime backend proxy", () => {
  const originalBackendOrigin = process.env.BACKEND_ORIGIN;
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    if (originalBackendOrigin === undefined) {
      delete process.env.BACKEND_ORIGIN;
    } else {
      process.env.BACKEND_ORIGIN = originalBackendOrigin;
    }
  });

  test("reads BACKEND_ORIGIN at request time and preserves the request path/query", async () => {
    const fetchMock = jest.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { authenticated: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = fetchMock;

    const { GET } = await import("../app/backend-api/[...path]/route");
    process.env.BACKEND_ORIGIN = "http://real-backend:3010";

    await GET(
      new Request("http://front.test/backend-api/auth/session?tab=1"),
      { params: Promise.resolve({ path: ["auth", "session"] }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://real-backend:3010/api/auth/session?tab=1",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );

    process.env.BACKEND_ORIGIN = "http://another-backend:3010";
    await GET(
      new Request("http://front.test/backend-api/auth/session"),
      { params: Promise.resolve({ path: ["auth", "session"] }) },
    );

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://another-backend:3010/api/auth/session",
    );
  });

  test("forwards Cookie, Origin, business headers, and request body", async () => {
    const fetchMock = jest.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    global.fetch = fetchMock;
    process.env.BACKEND_ORIGIN = "http://real-backend:3010";

    const { POST } = await import("../app/backend-api/[...path]/route");
    await POST(
      new Request("http://front.test/backend-api/conversations/c1/messages", {
        method: "POST",
        headers: {
          Cookie: "personchat_session=session-token",
          Origin: "http://front.test",
          "Content-Type": "application/json",
          "Idempotency-Key": "web-test-key",
          Host: "front.test",
          "X-Forwarded-Host": "attacker.test",
        },
        body: JSON.stringify({ content: "hello" }),
      }),
      {
        params: Promise.resolve({
          path: ["conversations", "c1", "messages"],
        }),
      },
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as unknown as Headers;
    const proxyInit = init as (RequestInit & { duplex?: string }) | undefined;
    expect(headers.get("cookie")).toBe("personchat_session=session-token");
    expect(headers.get("origin")).toBe("http://front.test");
    expect(headers.get("idempotency-key")).toBe("web-test-key");
    expect(headers.get("host")).toBeNull();
    expect(headers.get("x-forwarded-host")).toBeNull();
    expect(proxyInit?.duplex).toBe("half");
    expect(await new globalThis.Response(init?.body).text()).toBe(
      JSON.stringify({ content: "hello" }),
    );
  });

  test("returns backend status, response body, and Set-Cookie", async () => {
    const fetchMock = jest.fn<typeof fetch>();
    const upstream = new Response("event: connected\ndata: {}\n\n", {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "set-cookie": "personchat_session=next-token; Path=/; HttpOnly",
      },
    });
    fetchMock.mockResolvedValue(upstream);
    global.fetch = fetchMock;
    process.env.BACKEND_ORIGIN = "http://real-backend:3010";

    const { GET } = await import("../app/backend-api/[...path]/route");
    const response = await GET(
      new Request("http://front.test/backend-api/requests/r1/events"),
      { params: Promise.resolve({ path: ["requests", "r1", "events"] }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("set-cookie")).toContain(
      "personchat_session=next-token",
    );
    expect(await response.text()).toContain("event: connected");
  });
});
