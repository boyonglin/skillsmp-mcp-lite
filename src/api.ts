/**
 * SkillsMP API Client and Types
 */

// API Configuration
export const SKILLSMP_API_BASE = "https://skillsmp.com/api/v1";
export const API_TIMEOUT_MS = 30_000;

// Response Types
export interface Skill {
  id: string;
  name: string;
  description: string;
  author?: string;
  stars?: number;
  updatedAt?: number;
  tags?: string[];
  githubUrl?: string;
  skillUrl?: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface SearchResponse {
  success: boolean;
  data: {
    skills: Skill[];
    pagination: Pagination;
    filters?: {
      search: string;
      sortBy: string;
    };
  };
  meta?: {
    requestId: string;
    responseTimeMs: number;
  };
}

export interface AISearchResponse {
  success: boolean;
  data: {
    object: string;
    search_query: string;
    data: Array<{
      file_id: string;
      filename: string;
      score: number;
      skill?: Skill;
    }>;
    has_more: boolean;
    next_page: string | null;
  };
  meta?: {
    requestId: string;
    responseTimeMs: number;
  };
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

// API Client
export async function makeApiRequest<T>(
  endpoint: string,
  apiKey: string,
  params?: Record<string, string | number>
): Promise<T> {
  const url = new URL(`${SKILLSMP_API_BASE}/${endpoint}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as ApiError;
    throw new Error(
      errorData.error?.message ||
      `API request failed with status ${response.status}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Validate base response structure (shared logic)
 */
function validateBaseResponse(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') {
    throw new ApiStructureError('Invalid response: expected object');
  }

  const response = data as Record<string, unknown>;

  if (typeof response.success !== 'boolean') {
    throw new ApiStructureError('Invalid response: missing "success" field');
  }

  if (!response.success) {
    throw new ApiStructureError(`API returned failure: ${JSON.stringify(response)}`);
  }

  if (!response.data || typeof response.data !== 'object') {
    throw new ApiStructureError('Invalid response: missing "data" object');
  }

  return response.data as Record<string, unknown>;
}

/**
 * Validate search response structure
 */
export function validateSearchResponse(data: unknown): asserts data is SearchResponse {
  const responseData = validateBaseResponse(data);

  if (!Array.isArray(responseData.skills)) {
    throw new ApiStructureError(
      'Invalid response structure: expected "data.skills" array. ' +
      `Got: ${JSON.stringify(Object.keys(responseData))}. ` +
      'The SkillsMP API structure may have changed.'
    );
  }
}

/**
 * Validate AI search response structure
 */
export function validateAISearchResponse(data: unknown): asserts data is AISearchResponse {
  const responseData = validateBaseResponse(data);

  if (!Array.isArray(responseData.data)) {
    throw new ApiStructureError(
      'Invalid AI search response structure: expected "data.data" array. ' +
      `Got: ${JSON.stringify(Object.keys(responseData))}. ` +
      'The SkillsMP API structure may have changed.'
    );
  }
}

/**
 * Custom error for API structure changes
 */
export class ApiStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiStructureError';
  }
}

// Error Handler
export function handleApiError(error: unknown): string {
  if (error instanceof ApiStructureError) {
    return `⚠️ API Structure Error: ${error.message}\n\nThis likely means the SkillsMP API has changed. Please report this issue.`;
  }
  if (error instanceof Error) {
    if (error.message.includes("401")) {
      return "Error: Invalid or missing API key. Please check your SKILLSMP_API_KEY environment variable.";
    }
    if (error.message.includes("429")) {
      return "Error: Rate limit exceeded. Please wait before making more requests.";
    }
    return `Error: ${error.message}`;
  }
  return "Error: An unexpected error occurred";
}
