// Перевірка JWT Keycloak (розділ 07): підпис за JWKS, iss, exp, azp = web, роль.
// timetable-service приймає лише токен укладача з непорожнім school_id; токен sysadmin → 403.
// Виняток — /api/v1/public/*: без JWT, доступ за X-Access-Token (див. public.ts).
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { problem, sendProblem } from './problem.js';

export interface AccessToken extends JWTPayload {
  azp?: string;
  preferred_username?: string;
  school_id?: string;
  realm_access?: { roles?: string[] };
}

export type TokenVerifier = (token: string) => Promise<AccessToken>;

export interface VerifierOptions {
  issuer: string;
  clientId: string;
  /** JWKS віддалено (прод) або локальний набір ключів (тести). */
  keys: JWTVerifyGetKey;
}

export function createTokenVerifier({ issuer, clientId, keys }: VerifierOptions): TokenVerifier {
  return async (token) => {
    const { payload } = await jwtVerify<AccessToken>(token, keys, { issuer, algorithms: ['RS256'] });
    if (payload.azp !== clientId) throw new Error(`azp ${payload.azp ?? '—'} замість ${clientId}`);
    return payload;
  };
}

export const remoteKeys = (jwksUrl: string): JWTVerifyGetKey => createRemoteJWKSet(new URL(jwksUrl));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Хто діє і в якому закладі: береться лише з токена, у шляхах закладу немає. */
export interface Actor {
  schoolId: string;
  /** Для журналу: логін укладача (не прізвище вчителя). */
  actor: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

/** preHandler: лише токен web з роллю scheduler і school_id. Без токена — 401, інша роль — 403. */
export function requireScheduler(verify: TokenVerifier) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) {
      return sendProblem(reply, problem(401, 'unauthorized', 'Потрібен вхід'));
    }
    let user: AccessToken;
    try {
      user = await verify(token);
    } catch (err) {
      request.log.info({ reason: (err as Error).message }, 'токен відхилено');
      return sendProblem(reply, problem(401, 'unauthorized', 'Токен недійсний або прострочений'));
    }
    if (!user.realm_access?.roles?.includes('scheduler')) {
      return sendProblem(reply, problem(403, 'forbidden', 'Недостатньо прав', 'Потрібна роль scheduler'));
    }
    if (!user.school_id || !UUID_RE.test(user.school_id)) {
      return sendProblem(reply, problem(403, 'forbidden', 'Недостатньо прав', 'У токені немає закладу'));
    }
    request.actor = { schoolId: user.school_id.toLowerCase(), actor: user.preferred_username ?? user.sub ?? 'scheduler' };
  };
}

/** Після requireScheduler actor завжди є; функція лише звужує тип. */
export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw new Error('actorOf викликано без requireScheduler');
  return request.actor;
}
