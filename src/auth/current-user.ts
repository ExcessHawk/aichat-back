/**
 * Quién está pidiendo.
 *
 * El token lleva `{ sub, id, email, role, roles, jti }`. `roles` lo lee el
 * plugin RBAC para `@Roles(...)`; el resto lo relee este helper con tipo.
 */
import { getCurrentUser, UnauthorizedException } from 'veloce-ts';
import type { Context } from 'hono';

export type AppRole = 'user' | 'admin';

export interface AuthUser {
  id: number;
  email: string;
  role: AppRole;
  jti?: string;
}

export const ANY_ROLE = ['user', 'admin'];
export const ADMIN_ONLY = ['admin'];

export function requireUser(c: Context): AuthUser {
  const payload = getCurrentUser(c) as {
    id?: number;
    email?: string;
    role?: AppRole;
    jti?: string;
  } | null;
  if (!payload || payload.id == null || !payload.email || !payload.role) {
    throw new UnauthorizedException('Autenticación requerida');
  }
  return { id: Number(payload.id), email: payload.email, role: payload.role, jti: payload.jti };
}
