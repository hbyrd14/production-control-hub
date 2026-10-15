/** REST client. Every state-changing call carries the CSRF header the gateway requires. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-pch-request': '1' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const issues = Array.isArray(json?.issues) ? ` (${(json!.issues as string[]).join('; ')})` : '';
    throw new ApiError(res.status, `${(json?.error as string) ?? `Request failed (${res.status})`}${issues}`, json);
  }
  return json as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
