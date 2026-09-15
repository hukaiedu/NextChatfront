const DEFAULT_BACKEND_ORIGIN = "http://127.0.0.1:3010";

const REQUEST_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type HeadersWithSetCookie = Headers & {
  getSetCookie?: () => string[];
};

type ProxyContext = {
  params: Promise<{ path: string[] }>;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getBackendOrigin(): string {
  const rawOrigin =
    process.env.BACKEND_ORIGIN?.trim() || DEFAULT_BACKEND_ORIGIN;
  const origin = new URL(rawOrigin);

  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("BACKEND_ORIGIN must be an absolute HTTP(S) origin");
  }

  return origin.toString().replace(/\/$/, "");
}

function buildBackendUrl(request: Request, path: string[]): URL {
  const origin = new URL(`${getBackendOrigin()}/`);
  const backendPath = [
    "api",
    ...path.map((segment) => encodeURIComponent(segment)),
  ].join("/");
  const target = new URL(backendPath, origin);
  target.search = new URL(request.url).search;
  return target;
}

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers();

  for (const [name, value] of request.headers.entries()) {
    const normalizedName = name.toLowerCase();
    if (
      REQUEST_HOP_BY_HOP_HEADERS.has(normalizedName) ||
      normalizedName === "x-forwarded-for" ||
      normalizedName === "x-forwarded-host" ||
      normalizedName === "x-forwarded-proto" ||
      normalizedName === "x-real-ip"
    ) {
      continue;
    }
    headers.set(name, value);
  }

  return headers;
}

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  const sourceHeaders = response.headers as HeadersWithSetCookie;
  const setCookies = sourceHeaders.getSetCookie?.() ?? [];

  for (const [name, value] of response.headers.entries()) {
    const normalizedName = name.toLowerCase();
    if (
      RESPONSE_HOP_BY_HOP_HEADERS.has(normalizedName) ||
      normalizedName === "set-cookie"
    ) {
      continue;
    }
    headers.append(name, value);
  }

  if (setCookies.length > 0) {
    for (const cookie of setCookies) {
      headers.append("set-cookie", cookie);
    }
  } else {
    const combinedSetCookie = response.headers.get("set-cookie");
    if (combinedSetCookie) {
      headers.set("set-cookie", combinedSetCookie);
    }
  }

  return headers;
}

async function proxy(
  request: Request,
  context: ProxyContext,
): Promise<Response> {
  const { path } = await context.params;

  let target: URL;
  try {
    target = buildBackendUrl(request, path);
  } catch {
    return jsonResponse({ error: "Backend proxy is not configured" }, 500);
  }

  const fetchInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: copyRequestHeaders(request),
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  };

  if (request.body && request.method !== "GET" && request.method !== "HEAD") {
    fetchInit.body = request.body;
    fetchInit.duplex = "half";
  }

  try {
    const response = await fetch(target.toString(), fetchInit);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: copyResponseHeaders(response),
    });
  } catch (error) {
    if (request.signal.aborted) {
      throw error;
    }

    return jsonResponse({ error: "Backend unavailable" }, 502);
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
export const HEAD = proxy;
