/**
 * Registro, acceso y sesión.
 *
 * argon2id para la contraseña, par de tokens de Veloce, refresh persistido con
 * hash y revocación por `jti` en tabla: el logout corta de inmediato en vez de
 * esperar a que expire el token (00-base/PLANTILLA.md).
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, UnauthorizedException, type JWTProvider } from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { refreshTokens, revokedTokens, users } from '../db/schema';
import type { AppRole } from '../auth/current-user';

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionResult {
  token: string;
  refreshToken: string;
  user: { id: number; email: string; fullName: string; role: AppRole };
}

export class AuthService {
  constructor(private jwtProvider: JWTProvider) {}

  getJWTProvider(): JWTProvider {
    return this.jwtProvider;
  }

  private async issue(db: DrizzleDB, user: typeof users.$inferSelect): Promise<SessionResult> {
    const rol = user.role as AppRole;
    const { accessToken, refreshToken } = this.jwtProvider.generateTokens({
      sub: String(user.id),
      id: user.id,
      email: user.email,
      role: rol,
      roles: [rol],
      jti: randomUUID(),
    });

    const expira = new Date();
    expira.setDate(expira.getDate() + 30);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: digest(refreshToken),
      expiresAt: expira,
    });

    return {
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: rol },
    };
  }

  async register(
    db: DrizzleDB,
    body: { email: string; password: string; fullName: string },
  ): Promise<SessionResult> {
    const email = body.email.trim().toLowerCase();
    const [existe] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existe) throw new ConflictException('Ese correo ya está registrado');

    const [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await argonHash(body.password),
        fullName: body.fullName.trim(),
      })
      .returning();

    return this.issue(db, user);
  }

  async login(db: DrizzleDB, body: { email: string; password: string }): Promise<SessionResult> {
    const email = body.email.trim().toLowerCase();
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));

    // Mismo mensaje y mismo trabajo haya o no cuenta: la diferencia de tiempo
    // entre "no existe" y "contraseña mala" es un oráculo de correos válidos.
    const hash = user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$0000000000000000000000000000000000000000000';
    const correcta = await argonVerify(hash, body.password).catch(() => false);
    if (!user || !correcta) throw new UnauthorizedException('Correo o contraseña incorrectos');

    return this.issue(db, user);
  }

  /** Emite una sesión sin contraseña. Solo lo usa la demostración. */
  async issueForUser(db: DrizzleDB, userId: number): Promise<SessionResult> {
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    if (!user) throw new UnauthorizedException('Esa cuenta no existe');
    return this.issue(db, user);
  }

  async refresh(db: DrizzleDB, refreshToken: string): Promise<SessionResult> {
    const hash = digest(refreshToken);
    const [fila] = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)));
    if (!fila || fila.expiresAt < new Date()) {
      throw new UnauthorizedException('La sesión expiró, vuelve a entrar');
    }

    const [user] = await db.select().from(users).where(eq(users.id, fila.userId));
    if (!user) throw new UnauthorizedException('Esa cuenta ya no existe');

    // Rotación: el refresh usado no sirve dos veces.
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, fila.id));

    return this.issue(db, user);
  }

  /**
   * Cierra la sesión.
   *
   * El `jti` del token de acceso entra a la tabla de revocados, así que deja de
   * valer en la siguiente petición y no cuando expire.
   */
  async logout(db: DrizzleDB, jti: string | undefined, expiresAt: Date): Promise<void> {
    if (!jti) return;
    await db.insert(revokedTokens).values({ jti, expiresAt }).onConflictDoNothing();
  }
}
