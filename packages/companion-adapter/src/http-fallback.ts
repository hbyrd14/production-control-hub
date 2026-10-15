/**
 * Optional fallback for Companion's documented HTTP remote-control API
 * (https://companion.free/user-guide/v4.3/remote-control/http-remote-control):
 *   POST /api/location/<page>/<row>/<column>/down
 *   POST /api/location/<page>/<row>/<column>/up
 *
 * Used only for press/release of mapped locations when Satellite subscriptions
 * (API ≥ 1.10) are unavailable. It provides no button imagery or feedback.
 */
export interface Location {
  page: number;
  row: number;
  column: number;
}

export class CompanionHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 2000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromHost(host: string, port: number, timeoutMs?: number): CompanionHttpClient {
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return new CompanionHttpClient(`http://${h}:${port}`, timeoutMs);
  }

  down(l: Location): Promise<void> {
    return this.post(`/api/location/${l.page}/${l.row}/${l.column}/down`);
  }

  up(l: Location): Promise<void> {
    return this.post(`/api/location/${l.page}/${l.row}/${l.column}/up`);
  }

  private async post(path: string): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl + path, { method: 'POST', signal: ctrl.signal });
      if (!res.ok) throw new Error(`Companion HTTP ${res.status} for ${path}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
