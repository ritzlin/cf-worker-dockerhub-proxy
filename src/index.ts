interface Env {
  TOKEN_CACHE: any;
}

// DockerHub API endpoints
const DOCKERHUB_AUTH_URL = 'https://auth.docker.io/token';
const DOCKERHUB_REGISTRY_URL = 'https://registry-1.docker.io';

async function getAuthToken(scope: string, env: Env, forceRefresh = false): Promise<string> {
  // Try to get cached token unless force refresh is requested
  if (!forceRefresh) {
    const cachedToken = await env.TOKEN_CACHE.get(scope);
    if (cachedToken) {
      return cachedToken;
    }
  }

  // Get new token from DockerHub
  const params = new URLSearchParams({
    service: 'registry.docker.io',
    scope: scope,
  });

  const authResponse = await fetch(`${DOCKERHUB_AUTH_URL}?${params}`, {
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!authResponse.ok) {
    throw new Error(`Failed to get auth token: ${authResponse.statusText}`);
  }

  const authData: { token: string } = await authResponse.json();
  const token = authData.token;

  // Cache the token (typical TTL is 5 minutes)
  await env.TOKEN_CACHE.put(scope, token, { expirationTtl: 300 });

  return token;
}

async function makeRegistryRequest(url: string, options: RequestInit, scope: string, env: Env): Promise<Response> {
  // First attempt with potentially cached token
  let token = await getAuthToken(scope, env);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  let response = await fetch(url, {
    ...options,
    headers: headers,
    redirect: 'manual', // Handle redirects manually
  });

  // Handle 401 with token refresh
  if (response.status === 401) {
    console.log("Token expired, refreshing...");
    token = await getAuthToken(scope, env, true);
    headers.set('Authorization', `Bearer ${token}`);
    response = await fetch(url, {
      ...options,
      headers: headers,
      redirect: 'manual',
    });
  }

  // Handle redirects for blob downloads
  if (response.status === 307 || response.status === 302) {
    const redirectUrl = response.headers.get('location');
    if (!redirectUrl) {
      throw new Error('Redirect location not found');
    }
    response = await fetch(redirectUrl);
  }

  return response;
}

async function handleRegistryRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  const match = path.match(/^\/v2\/(.+?)\/(manifests|blobs)/);
  if (!match) {
    return new Response('Invalid registry request', { status: 400 });
  }

  const repository = match[1];
  const scope = `repository:${repository}:pull`;

  try {
    // Forward request to DockerHub
    const dockerHubUrl = `${DOCKERHUB_REGISTRY_URL}${path}`;
    const headers = new Headers(request.headers);

    // Add appropriate accept headers for manifests
    if (path.includes('/manifests/')) {
      headers.set('Accept', [
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.oci.image.index.v1+json'
      ].join(', '));
    }

    const response = await makeRegistryRequest(dockerHubUrl, {
      method: request.method,
      headers: headers,
      body: request.body,
    }, scope, env);

    if (!response.ok) {
      return new Response(`Registry error: ${response.statusText}`, { status: response.status });
    }

    // Forward the response back to client
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Docker-Distribution-Api-Version', 'registry/2.0');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return new Response(`Error: ${(error as { message?: string }).message}`, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Check if this is a registry API request
    if (request.url.includes('/v2/')) {
      return handleRegistryRequest(request, env);
    }

    // Handle version check
    if (request.url.endsWith('/v2/')) {
      return new Response(null, {
        status: 200,
        headers: {
          'Docker-Distribution-Api-Version': 'registry/2.0',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};