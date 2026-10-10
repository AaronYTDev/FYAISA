/**
 * fyaisaClient — a tiny, dependency-free client for the FYAISA bridge (ElevSH).
 *
 * Any homebrew Vega OS app can use this to reach the Vega CLI on the user's PC
 * through the same pairing FYAISA uses (`fyaisa connect` on the PC). Pass your
 * app id so the user can allow/deny you from FYAISA → ElevSH:
 *
 *   const fy = Fyaisa.from({host: '192.168.1.10', token, appId: 'app.x.main'});
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
 * ElevSH: pass an appId (Fyaisa.from({host, token, appId})) and every request
 * carries X-FYAISA-App. The bridge then applies the allow/deny list the user
 * manages in FYAISA → ElevSH: a 403 with code 'access_required' means FYAISA
 * has not approved this app yet (it is recorded as pending on first use);
 * 'access_denied' means the user said no.
 *
 * Security: `/vega` on the bridge only runs an allowlisted subset of the
 * `vega` CLI (device/platform/exec vda/--version), spawned without a shell.
 * This client does not widen that — it just makes it pleasant.
 */

export type FyaisaPairing = {host: string; token: string; appId?: string};

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
  /** Bridge error code: 'access_required' | 'access_denied' | null (none). */
  code: string | null;
  constructor(status: number, message: string, code?: string | null) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

export class Fyaisa {
  constructor(
    readonly host: string,
    readonly token: string,
    readonly port: number = 47821,
    /** This app's id — sent as X-FYAISA-App so FYAISA can allow/deny it. */
    readonly appId?: string,
  ) {}

  static from(p: FyaisaPairing, port: number = 47821): Fyaisa {
    return new Fyaisa(p.host, p.token, port, p.appId);
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
          ...(this.appId ? {'X-FYAISA-App': this.appId} : {}),
          ...(init && init.headers ? init.headers : {}),
        },
      });
    } catch (e: any) {
      throw new FyaisaError(0, `bridge unreachable at ${this.host}:${this.port} (${e?.message || e})`);
    }
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      throw new FyaisaError(res.status, body.error || `HTTP ${res.status}`, body.code);
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

  /**
   * Queue a build + install on the PC; poll job() for the build log.
   * Pass {patch: true} for a patch install: the bridge rebuilds the app
   * under its catalog `patch.for` identity (the original app's id and
   * display name, version forced to 99.99.99) and removes the original.
   */
  install(appId: string, opts: {patch?: boolean} = {}): Promise<{jobId: string}> {
    return this.req('/install', {
      method: 'POST',
      body: JSON.stringify(opts.patch ? {appId, patch: true} : {appId}),
    });
  }

  /**
   * Remove an installed app from the device. Hub and host tools only: the
   * bridge runs `vega device uninstall-app` and returns {ok, exitCode, log}.
   */
  uninstall(appId: string): Promise<{ok: boolean; exitCode: number | null; log: string[]}> {
    return this.req('/uninstall', {method: 'POST', body: JSON.stringify({appId})});
  }

  job(id: string): Promise<any> {
    return this.req(`/job?id=${encodeURIComponent(id)}`);
  }

  launch(appId: string): Promise<{ok: boolean}> {
    return this.req('/launch', {method: 'POST', body: JSON.stringify({appId})});
  }

  // ---- ElevSH access (FYAISA / owner only) --------------------------------

  /**
   * The allow/deny list the user manages in FYAISA → ElevSH:
   * [{appId, status: 'allow' | 'deny' | 'pending'}].
   */
  access(): Promise<{apps: {appId: string; status: string}[]}> {
    return this.req('/access');
  }

  /** Allow, deny, or revoke ('revoke') an app's ElevSH access. */
  setAccess(appId: string, decision: 'allow' | 'deny' | 'revoke'): Promise<any> {
    return this.req('/access', {method: 'POST', body: JSON.stringify({appId, decision})});
  }

  /** Approve a pending pairing code (grants that app ElevSH access too). */
  approvePairing(code: string): Promise<{ok: boolean; token?: string}> {
    return this.req('/pair/approve', {method: 'POST', body: JSON.stringify({code})});
  }

  /** App pairing requests waiting for a decision on the ElevSH screen. */
  pendingPairings(): Promise<{pairings: {code: string; appId: string; expiresIn: number}[]}> {
    return this.req('/pair/pending');
  }

  /**
   * Tokenless: has this app been allowed yet? Resolves
   * {appId, status: 'allow' | 'deny' | 'pending' | 'none'} — used by apps
   * before they hold a pairing.
   */
  static async accessStatus(host: string, appId: string, port: number = 47821): Promise<{status: string}> {
    let res: Response;
    try {
      res = await fetch(`http://${host}:${port}/access/status?appId=${encodeURIComponent(appId)}`);
    } catch (e: any) {
      throw new FyaisaError(0, `bridge unreachable at ${host}:${port} (${e?.message || e})`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any));
      throw new FyaisaError(res.status, body.error || `HTTP ${res.status}`, body.code);
    }
    return res.json();
  }

  // ---- pairing (no token yet) ----------------------------------------------

  /**
   * Ask the bridge for a pairing code. Pass appId so the bridge knows which
   * app is asking: an allowed app (allowed in FYAISA → ElevSH) pairing from
   * the Fire TV's own address is auto-approved — no code typing anywhere.
   * Resolves to {code, expiresIn, autoApproved}.
   */
  static async requestCode(
    host: string,
    port: number = 47821,
    appId?: string,
  ): Promise<{code: string; expiresIn: number; autoApproved?: boolean}> {
    let res: Response;
    try {
      res = await fetch(`http://${host}:${port}/pair/request`, {
        method: 'POST',
        headers: appId ? {'X-FYAISA-App': appId} : undefined,
      });
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
    opts: {appId?: string} = {},
  ): Promise<FyaisaPairing> {
    const deadline = Date.now() + timeoutMs;
    let tick = 0;
    while (Date.now() < deadline) {
      // With an appId, bail out fast if the user denies the app in FYAISA
      // instead of waiting for the code to expire (checked every 4th tick).
      if (opts.appId && tick % 4 === 0) {
        let acc: {status: string} | null = null;
        try {
          acc = await Fyaisa.accessStatus(host, opts.appId, port);
        } catch {
          acc = null; // bridge restarting — keep waiting
        }
        if (acc && acc.status === 'deny') {
          throw new FyaisaError(
            403,
            'ElevSH access denied for this app — allow it in FYAISA',
            'access_denied',
          );
        }
      }
      tick++;
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
