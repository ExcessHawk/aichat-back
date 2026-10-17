/**
 * El turno de conversación completo.
 *
 * El orden importa y es el del plan:
 *
 *   1. revisar el límite de gasto — antes de llamar a nadie
 *   2. guardar el mensaje del usuario
 *   3. insertar el del asistente vacío, con `streaming = true`
 *   4. transmitir, acumulando
 *   5. al cerrar, guardar contenido, tokens y costo
 *   6. si se corta a medias, guardar lo acumulado con `stoppedByUser`
 *
 * El mensaje vacío se inserta antes de empezar para que una caída a media
 * respuesta deje el parcial y no un hueco donde el usuario cree que escribió
 * algo que nunca existió.
 */
import { and, asc, eq } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { conversations, messages } from '../db/schema';
import {
  approximateTokens,
  costInCents,
  type ModelMessage,
  type ModelProvider,
} from './model.provider';
import type { UsageService } from './usage.service';

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costCents: number }
  | { type: 'done'; messageId: number; stopped: boolean }
  | { type: 'error'; message: string };

export class ChatService {
  constructor(
    private readonly provider: ModelProvider,
    private readonly usage: UsageService,
  ) {}

  private modelo(id: string) {
    const info = this.provider.models.find((m) => m.id === id);
    if (!info) throw new BadRequestException(`El modelo "${id}" no está disponible`);
    return info;
  }

  modelosDisponibles() {
    return this.provider.models;
  }

  /**
   * Responde a un mensaje, token a token.
   *
   * Es un generador: lo que emite va al canal SSE tal cual. El `finally` es la
   * red de seguridad — corre tanto si la respuesta terminó como si el navegador
   * se desconectó a media frase, y es lo único que garantiza que no quede una
   * fila marcada como `streaming` para siempre.
   */
  /**
   * Lo que hay que comprobar antes de abrir el canal.
   *
   * Va aparte del generador a propósito: dentro de un SSE las cabeceras ya se
   * fueron y un error solo puede contarse por el canal, con status 200. Aquí
   * todavía se puede responder 402 o 404 como corresponde.
   */
  async prepararTurno(
    db: DrizzleDB,
    input: { userId: number; conversationId: number; content: string },
  ) {
    const [conversacion] = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.id, input.conversationId), eq(conversations.userId, input.userId)),
      );
    if (!conversacion) throw new NotFoundException('Esa conversación no existe');

    const info = this.modelo(conversacion.model);
    const estimado = costInCents(info, {
      inputTokens: approximateTokens(input.content),
      outputTokens: 400,
    });
    await this.usage.assertDentroDelLimite(db, input.userId, estimado);
  }

  async *responder(
    db: DrizzleDB,
    input: {
      userId: number;
      conversationId: number;
      content: string;
      /** El del framework: hoy solo se dispara por timeout. */
      signal?: AbortSignal | null;
      /** El de la petición HTTP: este sí muere cuando el cliente se va. */
      requestSignal?: AbortSignal | null;
    },
  ): AsyncGenerator<ChatEvent> {
    const [conversacion] = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.id, input.conversationId), eq(conversations.userId, input.userId)),
      );
    if (!conversacion) throw new NotFoundException('Esa conversación no existe');

    const info = this.modelo(conversacion.model);

    const previos = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversacion.id))
      .orderBy(asc(messages.id));

    const historia: ModelMessage[] = previos
      .filter((m) => m.role !== 'system' && m.content.trim().length > 0)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    historia.push({ role: 'user', content: input.content });

    // Los dos mensajes quedan en la base antes del primer token: si el proceso
    // se cae a media respuesta, queda el parcial y no un hueco.
    await db.insert(messages).values({
      conversationId: conversacion.id,
      role: 'user',
      content: input.content,
    });
    const [asistente] = await db
      .insert(messages)
      .values({
        conversationId: conversacion.id,
        role: 'assistant',
        content: '',
        model: conversacion.model,
        streaming: true,
      })
      .returning();

    // El framework arma su propio AbortController por petición y hoy solo lo
    // dispara un timeout, así que la desconexión del cliente no llega por ahí:
    // llega como `cancel()` del stream, que entra a este `finally`. El control
    // propio es lo que corta de verdad la llamada al modelo.
    const control = new AbortController();
    const abortar = () => control.abort();
    input.signal?.addEventListener('abort', abortar, { once: true });
    input.requestSignal?.addEventListener('abort', abortar, { once: true });

    let acumulado = '';
    let entrada = 0;
    let salida = 0;
    let completo = false;

    try {
      for await (const evento of this.provider.stream({
        model: conversacion.model,
        system: conversacion.systemPrompt,
        messages: historia,
        signal: control.signal,
      })) {
        if (evento.type === 'text') {
          acumulado += evento.text;
          yield { type: 'token', text: evento.text };
        } else {
          entrada = evento.usage.inputTokens;
          salida = evento.usage.outputTokens;
        }
      }

      // Que el bucle termine no quiere decir que la respuesta terminara: un
      // proveedor que corta limpio al abortar también sale por aquí. Lo que
      // distingue los dos casos es la señal, no el final del bucle.
      if (control.signal.aborted) return;
      completo = true;

      const costo = costInCents(info, { inputTokens: entrada, outputTokens: salida });
      await this.cerrar(db, asistente.id, {
        content: acumulado,
        inputTokens: entrada,
        outputTokens: salida,
        costCents: costo,
        stoppedByUser: false,
      });
      await this.usage.registrar(db, input.userId, {
        inputTokens: entrada,
        outputTokens: salida,
        costCents: costo,
      });

      // El usage va antes del done para que el contador de la interfaz ya esté
      // puesto cuando la burbuja deja de parpadear.
      yield { type: 'usage', inputTokens: entrada, outputTokens: salida, costCents: costo };
      yield { type: 'done', messageId: asistente.id, stopped: false };
    } finally {
      // Cortar aquí es lo que deja de pagar tokens que nadie va a leer.
      control.abort();
      input.signal?.removeEventListener('abort', abortar);
      input.requestSignal?.removeEventListener('abort', abortar);

      if (!completo) {
        const parcial = { inputTokens: entrada, outputTokens: salida || approximateTokens(acumulado) };
        const costo = costInCents(info, parcial);
        await this.cerrar(db, asistente.id, {
          content: acumulado,
          inputTokens: parcial.inputTokens,
          outputTokens: parcial.outputTokens,
          costCents: costo,
          stoppedByUser: true,
        });
        // Lo que alcanzó a generarse se cobra igual: existió.
        await this.usage.registrar(db, input.userId, { ...parcial, costCents: costo });
      }
    }
  }

  private async cerrar(
    db: DrizzleDB,
    messageId: number,
    datos: {
      content: string;
      inputTokens: number;
      outputTokens: number;
      costCents: number;
      stoppedByUser: boolean;
    },
  ) {
    await db
      .update(messages)
      .set({ ...datos, streaming: false, updatedAt: new Date() })
      .where(eq(messages.id, messageId));
  }

  /**
   * Pone título a una conversación que no lo tiene.
   *
   * No se le pide al usuario: se saca del primer intercambio. Si falla, la
   * conversación se queda sin título y no pasa nada — no vale tirar el turno
   * por esto.
   */
  async titularSiHaceFalta(db: DrizzleDB, conversationId: number): Promise<void> {
    const [conversacion] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conversacion || conversacion.title) return;

    const previos = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.id));

    const utiles = previos
      .filter((m) => m.role !== 'system' && m.content.trim().length > 0)
      .slice(0, 2)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    if (utiles.length === 0) return;

    try {
      const titulo = await this.provider.title({ model: conversacion.model, messages: utiles });
      await db
        .update(conversations)
        .set({ title: titulo, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    } catch {
      /* sin título se vive */
    }
  }
}
