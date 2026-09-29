export const API_BASE_PATH = '/api/v1';

/** Joins the API origin, the versioned base path and a resource path without duplicate slashes. */
export function buildApiUrl(origin: string, path: string): string {
  const trimmedOrigin = origin.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  return `${trimmedOrigin}${API_BASE_PATH}/${trimmedPath}`;
}
