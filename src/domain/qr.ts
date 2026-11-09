// QR-токени класу й вчителя (розділ 11). Формат: school_id.token_id.MAC, де
// MAC = base64url(HMAC-SHA256(secret, school_id ‖ scope ‖ token_id ‖ generation)) з фіксованим
// кодуванням полів: uuid по 16 байт, scope 1 байт (class = 1, teacher = 2), generation int32 BE.
// Відкритий токен не зберігається, а відтворюється з БД і секрету, тож аркуш можна друкувати знову.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { withSchool, type Db, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import type { SchoolSnapshot } from '../school-client.js';
import { recordAudit, type Ctx, type Deps } from './context.js';

export type Scope = 'class' | 'teacher';
const SCOPE_BYTE: Record<Scope, number> = { class: 1, teacher: 2 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');

export function mac(secret: string, schoolId: string, scope: Scope, tokenId: string, generation: number): string {
  const gen = Buffer.alloc(4);
  gen.writeInt32BE(generation);
  const msg = Buffer.concat([uuidBytes(schoolId), Buffer.from([SCOPE_BYTE[scope]]), uuidBytes(tokenId), gen]);
  return createHmac('sha256', secret).update(msg).digest('base64url');
}

export const encodeToken = (secret: string, schoolId: string, scope: Scope, tokenId: string, generation: number) =>
  `${schoolId}.${tokenId}.${mac(secret, schoolId, scope, tokenId, generation)}`;

/** Розбір без перевірки MAC: перевірка — після читання рядка токена під RLS (потрібні scope і generation). */
export function parseToken(raw: string | undefined): { schoolId: string; tokenId: string; mac: string } | null {
  if (!raw || raw.length > 200) return null;
  const parts = raw.trim().split('.');
  if (parts.length !== 3) return null;
  const [schoolId, tokenId, m] = parts as [string, string, string];
  if (!UUID_RE.test(schoolId) || !UUID_RE.test(tokenId) || !/^[A-Za-z0-9_-]{43}$/.test(m)) return null;
  return { schoolId, tokenId, mac: m };
}

/** Порівняння MAC за сталий час (crypto.timingSafeEqual). */
export function macMatches(secret: string, schoolId: string, scope: Scope, tokenId: string, generation: number, given: string): boolean {
  const expected = Buffer.from(mac(secret, schoolId, scope, tokenId, generation));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Узгоджує токени зі знімком: новий клас чи вчитель отримує токен, архівований клас чи видалений
 * вчитель — revoked_at. Ідемпотентно; той самий код застосовує подія school.data.changed.
 */
export async function syncTokens(trx: Trx, schoolId: string, snapshot: Pick<SchoolSnapshot, 'classes' | 'teachers'>): Promise<void> {
  const targets: { scope: Scope; id: string; active: boolean }[] = [
    ...snapshot.classes.map((c) => ({ scope: 'class' as const, id: c.class_id, active: c.archived_at === null })),
    ...snapshot.teachers.map((t) => ({ scope: 'teacher' as const, id: t.teacher_id, active: t.deleted_at === null })),
  ];
  const active = targets.filter((t) => t.active);
  if (active.length > 0) {
    await trx
      .insertInto('access_tokens')
      .values(active.map((t) => ({ school_id: schoolId, token_id: randomUUID(), scope: t.scope, target_id: t.id, revoked_at: null })))
      .onConflict((oc) => oc.columns(['school_id', 'scope', 'target_id']).doNothing())
      .execute();
  }
  for (const t of targets.filter((x) => !x.active)) await revokeToken(trx, t.scope, t.id);
}

export async function ensureToken(trx: Trx, schoolId: string, scope: Scope, targetId: string): Promise<void> {
  await trx
    .insertInto('access_tokens')
    .values({ school_id: schoolId, token_id: randomUUID(), scope, target_id: targetId, revoked_at: null })
    .onConflict((oc) => oc.columns(['school_id', 'scope', 'target_id']).doNothing())
    .execute();
}

export async function revokeToken(trx: Trx, scope: Scope, targetId: string): Promise<void> {
  await trx
    .updateTable('access_tokens')
    .set({ revoked_at: new Date() })
    .where('scope', '=', scope)
    .where('target_id', '=', targetId)
    .where('revoked_at', 'is', null)
    .execute();
}

export interface AccessTokenView {
  token_id: string;
  scope: Scope;
  target_id: string;
  target_label: string;
  generation: number;
  url: string;
}

function labelsOf(snapshot: SchoolSnapshot): Map<string, string> {
  return new Map<string, string>([
    ...snapshot.classes.map((c) => [`class:${c.class_id}`, c.name] as const),
    ...snapshot.teachers.map((t) => [`teacher:${t.teacher_id}`, t.label] as const),
  ]);
}

const view = (deps: Deps, schoolId: string, labels: Map<string, string>) => (r: { token_id: string; scope: Scope; target_id: string; generation: number }): AccessTokenView => ({
  token_id: r.token_id,
  scope: r.scope,
  target_id: r.target_id,
  target_label: labels.get(`${r.scope}:${r.target_id}`) ?? '',
  generation: r.generation,
  url: `${deps.publicUrl}/${r.scope === 'class' ? 'c' : 't'}#${encodeToken(deps.qrSecret, schoolId, r.scope, r.token_id, r.generation)}`,
});

/** GET /access-tokens?type=class|teacher: відтворені посилання QR усіх активних класів чи вчителів. */
export async function listAccessTokens(deps: Deps, ctx: Ctx, scope: Scope): Promise<AccessTokenView[]> {
  const snapshot = await deps.fetchSnapshot(ctx.schoolId, ctx.correlationId);
  const labels = labelsOf(snapshot);
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    await syncTokens(trx, ctx.schoolId, snapshot);
    const rows = await trx
      .selectFrom('access_tokens')
      .select(['token_id', 'scope', 'target_id', 'generation'])
      .where('scope', '=', scope)
      .where('revoked_at', 'is', null)
      .execute();
    return rows.map(view(deps, ctx.schoolId, labels)).sort((a, b) => a.target_label.localeCompare(b.target_label, 'uk'));
  });
}

/** POST /access-tokens/{id}:rotate: generation + 1 — старий QR одразу недійсний, інші не змінюються. */
export async function rotateAccessToken(deps: Deps, ctx: Ctx, tokenId: string): Promise<AccessTokenView> {
  const snapshot = await deps.fetchSnapshot(ctx.schoolId, ctx.correlationId);
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    const row = await trx
      .updateTable('access_tokens')
      .set((eb) => ({ generation: eb('generation', '+', 1) }))
      .where('token_id', '=', tokenId)
      .where('revoked_at', 'is', null)
      .returning(['token_id', 'scope', 'target_id', 'generation'])
      .executeTakeFirst();
    if (!row) return fail(404, 'not_found', 'QR не знайдено');
    await recordAudit(trx, ctx, 'qr_rotated', row.target_id, { scope: row.scope, token_id: row.token_id, generation: row.generation }, deps.now());
    return view(deps, ctx.schoolId, labelsOf(snapshot))(row);
  });
}

export type TokenRow = { token_id: string; scope: Scope; target_id: string; generation: number };

/** Перевірка токена з X-Access-Token під RLS. Будь-яка невдача — null (однакова 404 для всіх випадків). */
export async function verifyAccess(db: Db, secret: string, raw: string | undefined): Promise<{ schoolId: string; token: TokenRow } | null> {
  const parsed = parseToken(raw);
  if (!parsed) return null;
  const row = await withSchool(db, parsed.schoolId, (trx) =>
    trx
      .selectFrom('access_tokens')
      .select(['token_id', 'scope', 'target_id', 'generation', 'revoked_at'])
      .where('token_id', '=', parsed.tokenId)
      .executeTakeFirst(),
  );
  if (!row || row.revoked_at !== null) return null;
  if (!macMatches(secret, parsed.schoolId, row.scope, row.token_id, row.generation, parsed.mac)) return null;
  return { schoolId: parsed.schoolId, token: { token_id: row.token_id, scope: row.scope, target_id: row.target_id, generation: row.generation } };
}
