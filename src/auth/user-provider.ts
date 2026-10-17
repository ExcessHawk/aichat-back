/**
 * `AuthPlugin` exige un UserProvider.
 *
 * El acceso lo maneja nuestro `AuthController`, así que `findByCredentials` no
 * se usa; `findById` respalda la verificación del token.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';

export const customUserProvider = {
  async findByCredentials(_email: string, _password: string) {
    return null;
  },
  async findById(id: string) {
    const { db } = await import('../db/client');
    const [user] = await db.select().from(users).where(eq(users.id, Number(id)));
    if (!user) return null;
    return {
      id: String(user.id),
      username: user.email,
      email: user.email,
      roles: [user.role],
    };
  },
  async hashPassword(password: string) {
    return argonHash(password);
  },
  async verifyPassword(password: string, hash: string) {
    return argonVerify(hash, password).catch(() => false);
  },
};
