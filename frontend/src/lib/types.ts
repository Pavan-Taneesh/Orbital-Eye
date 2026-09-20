export interface HealthResponse {
  status: string;
}

export interface ObjectSummary {
  object_id: number;
  name: string;
  norad_id: number;
  category_id: number;
}

export interface PaginatedResponse {
  results: ObjectSummary[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

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

export interface StateResponse {
  object_id: number;
  position: number[] | null;
  velocity: number[] | null;
  altitude: number | null;
  epoch: string | null;
  frame: string;
  source: string | null;
  age_hours: number | null;
  status: 'fresh' | 'stale' | 'error' | 'unavailable';
}

export interface StalenessInfo {
  age_hours: number;
  threshold_hours: number;
  is_stale: boolean;
}

export interface IngestionHistoryItem {
  element_id: number;
  source_id: number;
  epoch: string;
  fetched_at: string;
}

export interface DiagnosticsResponse {
  object_id: number;
  raw_latest_row: Record<string, unknown> | null;
  sgp4_error_code: number | null;
  staleness: StalenessInfo;
  ingestion_history: IngestionHistoryItem[];
  ingestion_row_count: number;
}

export interface MediaResponse {
  object_id: number;
  media: MediaResponseItem[];
}

export interface ErrorResponse {
  detail: string;
}

export interface SearchParams {
  q?: string;
  category?: number;
  limit?: number;
  offset?: number;
  [key: string]: string | number | undefined;
}

export interface ListParams {
  category?: number;
  limit?: number;
  offset?: number;
  [key: string]: string | number | undefined;
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api/v1';

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
      detail = errorData.detail || detail;
    } catch {
      // Use statusText if JSON parsing fails
    }
    throw createAPIError(response.status, detail);
  }
  return response.json();
}

function buildQuery(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.append(key, String(value));
    }
  });
  return searchParams.toString();
}

export const api = {
  health: async (): Promise<HealthResponse> => {
    const response = await fetch(`${API_BASE_URL}/health`);
    return handleResponse<HealthResponse>(response);
  },

  search: async (params: SearchParams = {}): Promise<PaginatedResponse> => {
    const query = buildQuery(params as Record<string, unknown>);
    const response = await fetch(`${API_BASE_URL}/objects/search?${query}`);
    return handleResponse<PaginatedResponse>(response);
  },

  list: async (params: ListParams = {}): Promise<PaginatedResponse> => {
    const query = buildQuery(params as Record<string, unknown>);
    const response = await fetch(`${API_BASE_URL}/objects?${query}`);
    return handleResponse<PaginatedResponse>(response);
  },

  get: async (objectId: number): Promise<ObjectDetails> => {
    const response = await fetch(`${API_BASE_URL}/objects/${objectId}`);
    return handleResponse<ObjectDetails>(response);
  },

  state: async (objectId: number): Promise<StateResponse> => {
    const response = await fetch(`${API_BASE_URL}/objects/${objectId}/state`);
    return handleResponse<StateResponse>(response);
  },

  diagnostics: async (objectId: number): Promise<DiagnosticsResponse> => {
    const response = await fetch(`${API_BASE_URL}/objects/${objectId}/diagnostics`);
    return handleResponse<DiagnosticsResponse>(response);
  },

  media: async (objectId: number): Promise<MediaResponse> => {
    const response = await fetch(`${API_BASE_URL}/objects/${objectId}/media`);
    return handleResponse<MediaResponse>(response);
  },
};