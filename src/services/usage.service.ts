/**
 * Lo que lleva gastado cada quien.
 *
 * El tope se revisa antes de llamar al modelo, no después. Un bucle aquí no es
 * un error de log: es una factura.
 */
import { and, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { usageLimits } from '../db/schema';

/** Tope por usuario y mes, en centavos de dólar. */
const LIMITE_POR_OMISION = Number(process.env.USAGE_LIMIT_CENTS ?? 200);

/** El periodo es el mes natural en UTC. */
export function inicioDePeriodo(ahora = new Date()): Date {
  return new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
}

export interface UsageView {
  periodStart: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  limitCents: number;
  restanteCents: number;
}

export class UsageService {
  async actual(db: DrizzleDB, userId: number): Promise<UsageView> {
    const periodo = inicioDePeriodo();
    const fila = await this.filaDelPeriodo(db, userId, periodo);
    return {
      periodStart: periodo.toISOString(),
      inputTokens: fila.inputTokens,
      outputTokens: fila.outputTokens,
      costCents: fila.costCents,
      limitCents: fila.limitCents,
      restanteCents: Math.max(0, fila.limitCents - fila.costCents),
    };
  }

  private async filaDelPeriodo(db: DrizzleDB, userId: number, periodo: Date) {
    const [existente] = await db
      .select()
      .from(usageLimits)
      .where(and(eq(usageLimits.userId, userId), eq(usageLimits.periodStart, periodo)));
    if (existente) return existente;

    // Entre la lectura y la inserción puede entrar otra petición del mismo
    // usuario; el índice único resuelve el empate y aquí se relee.
    const [creada] = await db
      .insert(usageLimits)
      .values({ userId, periodStart: periodo, limitCents: LIMITE_POR_OMISION })
      .onConflictDoNothing()
      .returning();
    if (creada) return creada;

    const [relectura] = await db
      .select()
      .from(usageLimits)
      .where(and(eq(usageLimits.userId, userId), eq(usageLimits.periodStart, periodo)));
    return relectura;
  }

  /**
   * ¿Alcanza para lo que va a costar esto?
   *
   * Se llama con una estimación, porque el costo real solo se sabe al terminar.
   * Pasarse por poco es tolerable; pasarse por mucho es lo que esto evita.
   */
  async assertDentroDelLimite(db: DrizzleDB, userId: number, estimadoCents: number) {
    const uso = await this.actual(db, userId);
    if (uso.costCents + estimadoCents > uso.limitCents) {
      // 402 es el código que la plantilla reserva para "hay que pagar", y el
      // frontend lo usa para mandar a la pantalla de consumo. El framework no
      // trae una excepción con ese nombre, así que se arma a mano.
      throw new HTTPException(
        402,
        `Llegaste al tope del periodo (${(uso.limitCents / 100).toFixed(2)} USD). Se reinicia el día 1.`,
        { limitCents: uso.limitCents, costCents: uso.costCents },
      );
    }
  }

  async registrar(
    db: DrizzleDB,
    userId: number,
    gasto: { inputTokens: number; outputTokens: number; costCents: number },
  ) {
    const periodo = inicioDePeriodo();
    await this.filaDelPeriodo(db, userId, periodo);
    await db
      .update(usageLimits)
      .set({
        inputTokens: sql`${usageLimits.inputTokens} + ${gasto.inputTokens}`,
        outputTokens: sql`${usageLimits.outputTokens} + ${gasto.outputTokens}`,
        costCents: sql`${usageLimits.costCents} + ${gasto.costCents}`,
        updatedAt: new Date(),
      })
      .where(and(eq(usageLimits.userId, userId), eq(usageLimits.periodStart, periodo)));
  }
}
