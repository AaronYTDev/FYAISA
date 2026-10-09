/**
 * fyaisaClient — a tiny, dependency-free client for the FYAISA bridge.
 *
 * Any homebrew Vega OS app can use this to reach the Vega CLI on the user's PC
 * through the same pairing FYAISA uses (`fyaisa connect` on the PC):
 *
 *   const fy = Fyaisa.from({host: '192.168.1.10', token});
 *   const cli = await fy.vega(['--version']);          // -> "Vega CLI Version: 1.4.4"
 *   const devs = await fy.vega(['device', 'list']);    // -> device list output
 *   const {jobId} = await fy.install('app.vegatube.main');
 *
 * Pairing (once, no token yet):
 *
 *   const {code} = await Fyaisa.requestCode(host);     // TV shows this code
 *   const pairing = await Fyaisa.waitForApproval(host, code); // user: fyaisa approve <code>
 *
 * Usage in an app: this file is vendored, not published — copy it into your
 * app's src/ (the canonical copy lives in bridge/client/ of the FYAISA repo;
 * installer/src/fyaisaClient.ts and apps/vegatube/src/fyaisaClient.ts are the
 * same file).
 *
 * Security: `/vega` on the bridge only runs an allowlisted subset of the
 * `vega` CLI (device/platform/exec vda/--version), spawned without a shell.
 * This client does not widen that — it just makes it pleasant.
 */

export type FyaisaPairing = {host: string; token: string};

export type VegaExecResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
};

export class FyaisaError extends Error {
  status: number; // 0 = bridge unreachable
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Fyaisa {
  constructor(
    readonly host: string,
    readonly token: string,
    readonly port: number = 47821,
  ) {}

  static from(p: FyaisaPairing, port: number = 47821): Fyaisa {
    return new Fyaisa(p.host, p.token, port);
  }

  private url(p: string): string {
    return `http://${this.host}:${this.port}${p}`;
  }

  private async req(path: string, init?: any): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        ...init,
        headers: {
          'X-FYAISA-Token': this.token,
          'Content-Type': 'application/json',
          ...(init && init.headers ? init.headers : {}),
        },
      });
    } catch (e: any) {
      throw new FyaisaError(0, `bridge unreachable at ${this.host}:${this.port} (${e?.message || e})`);
    }
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      throw new FyaisaError(res.status, body.error || `HTTP ${res.status}`);
    }
    return body;
  }

  // ---- authenticated API (requires the pairing token) ----------------------

  /** The hub catalog as the bridge sees it. */
  catalog(): Promise<any> {
    return this.req('/catalog');
  }

  /**
   * Run an allowlisted `vega` CLI command on the PC. Examples that work:
   *   ['--version'], ['device', 'list'], ['device', 'launch-app', '--appName', X],
   *   ['device', 'terminate-app', '--appName', X], ['exec', 'vda', 'connect', 'ip:5555'],
   *   ['device', 'run-cmd', '--command', 'ls /data']
   * The bridge rejects anything outside its allowlist with 403.
   */
  async vega(argv: string[], timeoutMs: number = 30000): Promise<VegaExecResult> {
    const r = await this.req('/vega', {method: 'POST', body: JSON.stringify({args: argv, timeoutMs})});
    return {
      ok: !!r.ok,
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      truncated: !!r.truncated,
      durationMs: r.durationMs || 0,
    };
  }

  /** Queue a build + install on the PC; poll job() for the build log. */
  install(appId: string): Promise<{jobId: string}> {
    return this.req('/install', {method: 'POST', body: JSON.stringify({appId})});
  }

  job(id: string): Promise<any> {
    return this.req(`/job?id=${encodeURIComponent(id)}`);
  }

  launch(appId: string): Promise<{ok: boolean}> {
    return this.req('/launch', {method: 'POST', body: JSON.stringify({appId})});
  }

  // ---- pairing (no token yet) ----------------------------------------------

  /** Ask the bridge for a pairing code; show it to the user / approve on the PC. */
  static async requestCode(host: string, port: number = 47821): Promise<{code: string; expiresIn: number}> {
    let res: Response;
    try {
      res = await fetch(`http://${host}:${port}/pair/request`, {method: 'POST'});
    } catch (e: any) {
      throw new FyaisaError(0, `bridge unreachable at ${host}:${port} (${e?.message || e})`);
    }
    if (!res.ok) {
      throw new FyaisaError(res.status, `pairing request failed (HTTP ${res.status})`);
    }
    return res.json();
  }

  /**
   * Poll until the code is approved on the PC (`fyaisa approve <code>`), then
   * exchange it for the token. Resolves to the persisted pairing.
   */
  static async waitForApproval(
    host: string,
    code: string,
    port: number = 47821,
    pollMs: number = 2000,
    timeoutMs: number = 10 * 60 * 1000,
  ): Promise<FyaisaPairing> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let res: Response | null = null;
      try {
        res = await fetch(`http://${host}:${port}/pair/status?code=${encodeURIComponent(code)}`);
      } catch {
        res = null; // PC may be restarting the bridge; keep polling
      }
      if (res && res.ok) {
        const st = await res.json();
        if (st.approved) {
          const ok = await fetch(`http://${host}:${port}/pair/approve`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code, device: 'fyaisa-client'}),
          });
          if (ok.ok) {
            const j = await ok.json();
            return {host, token: j.token};
          }
        }
      }
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
    throw new FyaisaError(408, 'pairing timed out — the code was not approved in time');
  }
}
