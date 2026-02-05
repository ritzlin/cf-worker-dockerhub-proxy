interface Env {
  TOKEN_CACHE: any;
}

// Carries an upstream HTTP status so the catch block can propagate it
// instead of collapsing every failure into 500.
class RegistryError extends Error {
  status: number;
  retryAfter: string | null;
  constructor(message: string, status: number, retryAfter: string | null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// DockerHub API endpoints
const DOCKERHUB_AUTH_URL = "https://auth.docker.io/token";
const DOCKERHUB_REGISTRY_URL = "https://registry-1.docker.io";

async function getAuthToken(
  scope: string,
  env: Env,
  forceRefresh = false
): Promise<string> {
  // Try to get cached token unless force refresh is requested
  if (!forceRefresh) {
    const cachedToken = await env.TOKEN_CACHE.get(scope);
    if (cachedToken) {
      return cachedToken;
    }
  }

  // Get new token from DockerHub
  const params = new URLSearchParams({
    service: "registry.docker.io",
    scope: scope,
  });

  const authResponse = await fetch(`${DOCKERHUB_AUTH_URL}?${params}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!authResponse.ok) {
    throw new RegistryError(
      `Failed to get auth token: ${authResponse.statusText}`,
      authResponse.status,
      authResponse.headers.get("Retry-After")
    );
  }

  const authData: { token: string } = await authResponse.json();
  const token = authData.token;

  // Cache the token (typical TTL is 5 minutes)
  await env.TOKEN_CACHE.put(scope, token, { expirationTtl: 300 });

  return token;
}

async function makeRegistryRequest(
  url: string,
  options: RequestInit,
  scope: string,
  env: Env
): Promise<Response> {
  // First attempt with potentially cached token
  let token = await getAuthToken(scope, env);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  let response = await fetch(url, {
    ...options,
    headers: headers,
    redirect: "manual", // Handle redirects manually
  });

  // Handle 401 with token refresh
  if (response.status === 401) {
    console.log("Token expired, refreshing...");
    token = await getAuthToken(scope, env, true);
    headers.set("Authorization", `Bearer ${token}`);
    response = await fetch(url, {
      ...options,
      headers: headers,
      redirect: "manual",
    });
  }

  // Handle redirects for blob downloads
  if (response.status === 307 || response.status === 302) {
    const redirectUrl = response.headers.get("location");
    if (!redirectUrl) {
      throw new Error("Redirect location not found");
    }
    response = await fetch(redirectUrl);
  }

  return response;
}

async function handleRegistryRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  const match = path.match(/^\/v2\/(.+)\/(manifests|blobs)/);
  if (!match) {
    return new Response("Invalid registry request", { status: 400 });
  }

  const repository = match[1];
  const scope = `repository:${repository}:pull`;

  try {
    // Forward request to DockerHub
    const dockerHubUrl = `${DOCKERHUB_REGISTRY_URL}${path}`;
    const headers = new Headers(request.headers);

    const response = await makeRegistryRequest(
      dockerHubUrl,
      {
        method: request.method,
        headers: headers,
        // GET/HEAD must never carry a body; on CF Workers (HTTP/2) the
        // incoming request.body can be a closed ReadableStream instead of
        // null, which causes fetch() to throw a TypeError.
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      },
      scope,
      env
    );

    if (!response.ok) {
      console.log("error", response.status, response.statusText);
    }

    // Forward the response back to client
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("handleRegistryRequest failed:", error);

    // Propagate the upstream status when available; otherwise 500.
    const status = error instanceof RegistryError ? error.status : 500;
    const responseHeaders = new Headers({
      "Content-Type": "application/json",
      "Docker-Distribution-Api-Version": "registry/2.0",
    });

    // Forward the Retry-After the upstream sent, or default for 429/503.
    // Docker's client honours Retry-After and will back off + retry.
    if (error instanceof RegistryError && error.retryAfter) {
      responseHeaders.set("Retry-After", error.retryAfter);
    } else if (status === 429 || status === 503) {
      responseHeaders.set("Retry-After", "60");
    }

    // OCI distribution error envelope — Docker parses this on GET
    // responses and surfaces the message to the user.
    const message =
      error instanceof Error ? error.message : "unknown error";
    return new Response(
      JSON.stringify({ errors: [{ code: "UNKNOWN", message }] }),
      { status, headers: responseHeaders }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Docker mirror health-probe
    if (
      url.pathname === "/v2/" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      console.log("[/v2/ probe] ua=", request.headers.get("user-agent") || "");
      return new Response("{}", {
        status: 200,
        headers: {
          "Docker-Distribution-Api-Version": "registry/2.0",
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    console.log("request", request.url);

    if (url.pathname.startsWith("/v2/")) {
      return handleRegistryRequest(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};
