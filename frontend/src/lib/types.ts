export interface MediaResponseItem {
  url: string;
  media_type: string;
  source_id: number | null;
}

export interface ObjectDetails {
  object_id: number;
  name: string;
  category_id: number | null;
  category: string | null;
  norad_id: number | null;
  metadata: Record<string, string>;
  media: MediaResponseItem[];
}

export interface AICommandResult {
  success?: boolean;
  command: string | null;
  ai_response?: string | null;
  error?: string | null;
  error_type?: string | null;
  result?: {
    data?: {
      object?: { object_id: number };
      object_id?: number;
      results?: Array<{ object_id: number }>;
      category?: number;
      count?: number;
      total_count?: number;
      limit?: number;
      offset?: number;
      has_more?: boolean;
    };
  };
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api/v1';

// Default timeout for API requests (10 seconds)
export const API_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // If an external signal is provided, link it to our controller
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort()
    } else {
      options.signal.addEventListener('abort', () => controller.abort())
    }
  }

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface APIError extends Error {
  statusCode: number;
  detail: string;
  response?: unknown;
}

export function createAPIError(statusCode: number, detail: string, response?: unknown): APIError {
  const error = new Error(`API request failed [${statusCode}]: ${detail}`) as APIError;
  error.name = 'APIError';
  error.statusCode = statusCode;
  error.detail = detail;
  error.response = response;
  return error;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errorData = await response.json();
      if (typeof errorData?.detail === 'string') detail = errorData.detail;
    } catch {
      // Use statusText if JSON parsing fails
    }
    throw createAPIError(response.status, detail);
  }
  return response.json();
}

function objectPath(objectId: number): string {
  if (!Number.isSafeInteger(objectId) || objectId <= 0) {
    throw createAPIError(400, `Invalid object id: ${objectId}`);
  }
  return `${API_BASE_URL}/objects/${objectId}`;
}

/* ------------------------------------------------------------------
   GET cache
   ------------------------------------------------------------------
   Every GET goes through one cache keyed by URL:
   - concurrent callers for the same URL share one in-flight request;
   - a resolved response is reused until its TTL expires;
   - failures are evicted so a retry really hits the network;
   - each caller receives its own deep copy, so no two consumers ever
     hold (and accidentally mutate) the same response object.
   ------------------------------------------------------------------ */

const CACHE_MAX_ENTRIES = 300;
const TTL = {
  details: 5 * 60_000,
};

type CacheEntry = { expires: number; promise: Promise<unknown> };
const getCache = new Map<string, CacheEntry>();

function cachedGet<T>(url: string, ttlMs: number): Promise<T> {
  const now = Date.now();
  const hit = getCache.get(url);
  if (hit && hit.expires > now) {
    // Refresh recency so the eviction below behaves like an LRU.
    getCache.delete(url);
    getCache.set(url, hit);
    return hit.promise.then((data) => structuredClone(data) as T);
  }

  const promise = fetchWithTimeout(url).then((response) => handleResponse<T>(response));
  const entry: CacheEntry = { expires: Number.POSITIVE_INFINITY, promise };
  getCache.set(url, entry);
  promise.then(
    () => {
      // TTL starts when the data arrives, not when it was requested.
      entry.expires = Date.now() + ttlMs;
    },
    () => {
      if (getCache.get(url) === entry) getCache.delete(url);
    },
  );

  while (getCache.size > CACHE_MAX_ENTRIES) {
    const oldest = getCache.keys().next().value;
    if (oldest === undefined) break;
    getCache.delete(oldest);
  }

  return promise.then((data) => structuredClone(data) as T);
}

/** Only http(s) links from the backend are allowed into href attributes. */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export const api = {
  /** Object details. Includes `media`, so a separate media call is unnecessary. */
  get: async (objectId: number): Promise<ObjectDetails> => {
    return cachedGet<ObjectDetails>(objectPath(objectId), TTL.details);
  },

  // POST: never cached, each question is a new request.
  explore: async (params: { request: string }): Promise<AICommandResult> => {
    const response = await fetchWithTimeout(`${API_BASE_URL}/ai/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return handleResponse<AICommandResult>(response);
  },
};
