/**
 * Límites por ruta.
 *
 * El global protege el proceso; estos protegen la cartera y las contraseñas.
 */
import { createRateLimitMiddleware } from 'veloce-ts';
import type { Context } from 'hono';
import { getCurrentUser } from 'veloce-ts';

const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 0);

export function clientIp(c: Context): string {
  if (TRUST_PROXY_HOPS > 0) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const cadena = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const i = cadena.length - TRUST_PROXY_HOPS;
      if (i >= 0 && cadena[i]) return cadena[i];
    }
  }
  return c.req.header('x-real-ip') ?? 'unknown-ip';
}

export const authRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
  keyGenerator: (c) => `auth:${clientIp(c as Context)}`,
});

/**
 * El del chat va por usuario y no por IP: aquí cada petición cuesta dinero de
 * verdad, y dos personas detrás del mismo NAT no tienen por qué compartir tope.
 */
export const chatRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: Number(process.env.CHAT_RATE_LIMIT_MAX ?? 20),
  keyGenerator: (c) => {
    const user = getCurrentUser(c as Context) as { id?: number } | null;
    return user?.id ? `chat:u${user.id}` : `chat:${clientIp(c as Context)}`;
  },
});

export const demoRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: Number(process.env.DEMO_RATE_LIMIT_MAX ?? 40),
  keyGenerator: (c) => `demo:${clientIp(c as Context)}`,
});
