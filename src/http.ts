import type { ApiClient, WalletConfig } from "./types.js";

// Above the API's longest in-request wait, about 20 s of relayer polling.
const API_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createApiClient(config: WalletConfig): ApiClient {
  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Following a redirect would re-post a signed payload wherever it points.
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(
          `API ${method} ${path} did not answer within ${API_TIMEOUT_MS / 1000} s; it may still have processed the request`,
        );
      }
      throw error;
    }
    // Checked before parsing: an error page or a redirect is rarely JSON.
    if (!response.ok) {
      throw new ApiError(
        `API ${method} ${path} failed with ${response.status}: ${text}`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    get: (path, headers) => request("GET", path, undefined, headers),
    post: (path, body) => request("POST", path, body),
  };
}
