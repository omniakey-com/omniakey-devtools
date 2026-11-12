import { DurableObject } from 'cloudflare:workers';

type Decision = { ok: true; lease?: string } | { ok: false; code: string };

/** One object per irreversible API-key fingerprint. Never stores credentials,
 * prompts, task content or output. Synchronous SQL makes limits global and
 * atomic across connections, regions and concurrent Worker requests. */
export class CredentialGuard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, expires INTEGER NOT NULL, daily_limit INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    `);
  }

  register(id: string, expiresAt: number, dailyLimit: number): Decision {
    if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 20 ||
        expiresAt <= Date.now() || expiresAt > Date.now() + 7 * 86400_000 + 1000) return { ok: false, code: 'invalid_connection' };
    this.cleanup();
    const active = this.ctx.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM connections WHERE revoked = 0').one().count;
    if (active >= 20) return { ok: false, code: 'too_many_connections' };
    this.ctx.storage.sql.exec('INSERT INTO connections(id, expires, daily_limit) VALUES (?, ?, ?)', id, expiresAt, dailyLimit);
    return { ok: true };
  }

  revoke(id: string): void {
    this.ctx.storage.sql.exec('UPDATE connections SET revoked = 1 WHERE id = ?', id);
  }

  check(id: string): Decision {
    const row = this.ctx.storage.sql.exec<{ revoked: number; expires: number }>('SELECT revoked, expires FROM connections WHERE id = ?', id).toArray()[0];
    return !row || row.revoked || row.expires <= Date.now() ? { ok: false, code: 'connection_revoked' } : { ok: true };
  }

  acquire(id: string, paid: boolean): Decision {
    this.cleanup();
    const active = this.check(id);
    if (!active.ok) return active;
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const hour = Math.floor(now / 3600_000);
    const day = Math.floor(now / 86400_000);
    const counters = [{ id: `read:${minute}`, limit: 120, expires: now + 120_000 }];
    if (paid) {
      const row = this.ctx.storage.sql.exec<{ daily_limit: number }>('SELECT daily_limit FROM connections WHERE id = ?', id).one();
      counters.push(
        { id: `paid:${minute}`, limit: 6, expires: now + 120_000 },
        { id: `hour:${hour}`, limit: 30, expires: now + 7200_000 },
        { id: `day:${day}`, limit: 100, expires: now + 2 * 86400_000 },
        { id: `connection:${id}:${day}`, limit: row.daily_limit, expires: now + 2 * 86400_000 },
      );
      if (this.ctx.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM leases').one().count >= 2) {
        return { ok: false, code: 'concurrency_limit' };
      }
    }
    for (const c of counters) {
      const row = this.ctx.storage.sql.exec<{ count: number }>('SELECT count FROM counters WHERE id = ?', c.id).toArray()[0];
      if (row && row.count >= c.limit) return { ok: false, code: 'request_limit' };
    }
    for (const c of counters) this.ctx.storage.sql.exec(
      'INSERT INTO counters(id, count, expires) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET count = count + 1', c.id, c.expires,
    );
    if (!paid) return { ok: true };
    const lease = crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO leases(id, expires) VALUES (?, ?)', lease, now + 150_000);
    return { ok: true, lease };
  }

  release(lease: string): void { this.ctx.storage.sql.exec('DELETE FROM leases WHERE id = ?', lease); }

  private cleanup(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM connections WHERE expires <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM counters WHERE expires <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE expires <= ?', now);
  }
}
