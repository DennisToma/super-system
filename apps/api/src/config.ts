import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

export interface AppConfig {
  host: string; port: number; origin: string; password?: string; sessionSecret?: string;
  secureCookie: boolean; databaseUrl?: string; dataDir: string; staticDir: string;
  environment: 'development' | 'production' | 'test';
}
export function workspaceRoot(start = process.cwd()): string {
  let dir = resolve(start);
  while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
    const parent = resolve(dir, '..');
    if (parent === dir) return resolve(start);
    dir = parent;
  }
  return dir;
}
export function readConfig(env = process.env): AppConfig {
  const root = workspaceRoot();
  if (env === process.env) loadEnv({ path: resolve(root, '.env'), quiet: true });
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const environment = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const originUrl = new URL(env.APP_ORIGIN || 'http://127.0.0.1:5173');
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path or credentials.');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const password = env.APP_PASSWORD || undefined;
  const sessionSecret = env.SESSION_SECRET || undefined;
  if ((!local || environment === 'production') && !password) throw new Error('APP_PASSWORD is required for production or a non-loopback bind address.');
  if (password && (password.length < 12 || !sessionSecret || sessionSecret.length < 32)) throw new Error('Use an APP_PASSWORD of at least 12 characters and a SESSION_SECRET of at least 32 characters.');
  const secureCookie = env.COOKIE_SECURE === 'true';
  if (environment === 'production' && (originUrl.protocol !== 'https:' || !secureCookie)) throw new Error('Production requires HTTPS APP_ORIGIN and COOKIE_SECURE=true behind a TLS reverse proxy.');
  return { host, port, origin: originUrl.origin, password, sessionSecret, secureCookie, databaseUrl: env.DATABASE_URL || undefined,
    dataDir: resolve(root, env.APP_DATA_DIR || '.data'), staticDir: resolve(root, env.STATIC_DIR || 'apps/web/dist'), environment };
}
