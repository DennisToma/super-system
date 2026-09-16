import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { ProviderError } from '@super-system/core';
import type { AppConfig } from './config.js';

const cookieName = 'super_system_session';
const lifetimeSeconds = 7 * 24 * 60 * 60;
const equal = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
export async function registerAuth(app: FastifyInstance, config: AppConfig) {
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const salt = randomBytes(32);
  const passwordHash = config.password ? scryptSync(config.password, salt, 64) : null;
  const signature = (value: string) => createHmac('sha256', config.sessionSecret || '').update(value).digest('base64url');
  const authenticated = (request: FastifyRequest) => {
    if (!config.password) return true;
    const token = request.cookies[cookieName];
    if (!token || token.length > 1000) return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !equal(signature(parts[0]), parts[1])) return false;
    try { const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); return typeof data.exp === 'number' && data.exp > Date.now(); } catch { return false; }
  };
  const allowedHosts = new Set([new URL(config.origin).host, `127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (!allowedHosts.has(request.headers.host || '')) throw new ProviderError('FORBIDDEN_HOST', 'This host is not allowed.', 403);
    const origin = request.headers.origin;
    if (origin && origin !== config.origin) throw new ProviderError('FORBIDDEN_ORIGIN', 'This origin is not allowed.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new ProviderError('FORBIDDEN_ORIGIN', 'Cross-site requests are not allowed.', 403);
    if (!config.password && (request.headers['x-forwarded-for'] || request.headers.forwarded || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip))) throw new ProviderError('AUTH_REQUIRED', 'Configure authentication before exposing the API through a proxy.', 403);
    // Authenticate the matched route, not the raw URL: encoded static path
    // segments (for example /%61pi/preferences) route to the same handler.
    const pathname = request.routeOptions.url || request.url.split('?')[0];
    if (pathname.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['/api/auth/session', '/api/auth/login', '/api/health'].includes(pathname) && !authenticated(request)) throw new ProviderError('UNAUTHENTICATED', 'Sign in to access your workspace.', 401);
    }
  });
  app.get('/api/auth/session', async request => ({ authenticated: authenticated(request), required: Boolean(config.password) }));
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!config.password) return { authenticated: true };
    const input = z.object({ password: z.string().max(1000) }).parse(request.body);
    if (!timingSafeEqual(scryptSync(input.password, salt, 64), passwordHash!)) throw new ProviderError('INVALID_PASSWORD', 'Incorrect password.', 401);
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + lifetimeSeconds * 1000, nonce: randomBytes(24).toString('base64url') })).toString('base64url');
    reply.setCookie(cookieName, `${payload}.${signature(payload)}`, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookie, maxAge: lifetimeSeconds });
    return { authenticated: true };
  });
  app.post('/api/auth/logout', async (_request, reply) => { reply.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookie }); return { ok: true }; });
}
