/**
 * Conversaciones y el canal que las hace vivir.
 *
 * Todo lo que cuelga de aquí es del usuario que pide: no hay conversación
 * compartida, así que cada consulta filtra por `userId` y no por rol.
 */
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Delete,
  Get,
  Inject,
  InjectDB,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Roles,
  SSE,
  UseMiddleware,
  AbortSignal as RequestAbortSignal,
} from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { attachments, conversations, messages } from '../db/schema';
import { ANY_ROLE, requireUser } from '../auth/current-user';
import { ChatService, type ChatEvent } from '../services/chat.service';
import {
  CreateConversationSchema,
  SendMessageSchema,
  UpdateConversationSchema,
  type CreateConversationDto,
  type SendMessageDto,
  type UpdateConversationDto,
} from '../dtos/chat.dto';
import { chatRateLimit } from '../middleware/rate-limit.middleware';

@Controller('/api/conversations')
export class ConversationsController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(ChatService) private chat: ChatService,
  ) {}

  private async propia(c: Context, id: string) {
    const user = requireUser(c);
    const [fila] = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, Number(id)),
          eq(conversations.userId, user.id),
          isNull(conversations.deletedAt),
        ),
      );
    if (!fila) throw new NotFoundException('Esa conversación no existe');
    return { user, conversacion: fila };
  }

  @Get('/')
  @Roles(ANY_ROLE)
  async list(@Ctx() c: Context, @Query('limit') limit?: string) {
    const user = requireUser(c);
    const tope = Math.min(Number(limit ?? 50) || 50, 100);

    return {
      conversations: await this.db
        .select({
          id: conversations.id,
          title: conversations.title,
          model: conversations.model,
          archivedAt: conversations.archivedAt,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
          // Los nombres van escritos, no interpolados: Drizzle escribe las
          // columnas sin calificar dentro de un fragmento crudo, así que
          // `${'${messages.conversationId}'} = ${'${conversations.id}'}` se vuelve
          // `"conversation_id" = "id"` y dentro de la subconsulta las dos
          // resuelven contra messages. La cuenta salía siempre en cero.
          messageCount: sql<number>`(
            SELECT count(*)::int FROM messages
             WHERE messages.conversation_id = conversations.id
          )`,
          costCents: sql<number>`(
            SELECT COALESCE(sum(messages.cost_cents), 0)::int FROM messages
             WHERE messages.conversation_id = conversations.id
          )`,
        })
        .from(conversations)
        .where(and(eq(conversations.userId, user.id), isNull(conversations.deletedAt)))
        .orderBy(desc(conversations.updatedAt))
        .limit(tope),
    };
  }

  @Post('/')
  @Roles(ANY_ROLE)
  async create(@Body(CreateConversationSchema) body: CreateConversationDto, @Ctx() c: Context) {
    const user = requireUser(c);
    const modelos = this.chat.modelosDisponibles();
    const modelo = body.model ?? modelos[0].id;
    if (!modelos.some((m) => m.id === modelo)) {
      throw new NotFoundException(`El modelo "${modelo}" no está disponible`);
    }

    const [fila] = await this.db
      .insert(conversations)
      .values({
        userId: user.id,
        model: modelo,
        systemPrompt: body.systemPrompt,
        title: body.title,
      })
      .returning();
    c.status(201);
    return fila;
  }

  @Patch('/:id')
  @Roles(ANY_ROLE)
  async update(
    @Param('id') id: string,
    @Body(UpdateConversationSchema) body: UpdateConversationDto,
    @Ctx() c: Context,
  ) {
    const { conversacion } = await this.propia(c, id);
    const [fila] = await this.db
      .update(conversations)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.archived !== undefined ? { archivedAt: body.archived ? new Date() : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversacion.id))
      .returning();
    return fila;
  }

  @Delete('/:id')
  @Roles(ANY_ROLE)
  async remove(@Param('id') id: string, @Ctx() c: Context) {
    const { conversacion } = await this.propia(c, id);
    // Borrado suave: los mensajes se quedan, porque el consumo del periodo se
    // calculó con ellos y borrarlos cambiaría una cuenta ya cerrada.
    await this.db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(eq(conversations.id, conversacion.id));
    return { message: 'Conversación borrada' };
  }

  @Get('/:id/messages')
  @Roles(ANY_ROLE)
  async messages(
    @Param('id') id: string,
    @Ctx() c: Context,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const { conversacion } = await this.propia(c, id);
    const tope = Math.min(Number(limit ?? 50) || 50, 200);

    // Se pagina hacia atrás: lo último es lo que se ve primero en pantalla.
    const filas = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversacion.id),
          before ? lt(messages.id, Number(before)) : undefined,
        ),
      )
      .orderBy(desc(messages.id))
      .limit(tope);

    return { messages: filas.reverse(), hasMore: filas.length === tope };
  }

  /** Los documentos que acompañan a esta conversación. */
  @Get('/:id/attachments')
  @Roles(ANY_ROLE)
  async attachments(@Param('id') id: string, @Ctx() c: Context) {
    const { conversacion } = await this.propia(c, id);
    return {
      attachments: await this.db
        .select({
          id: attachments.id,
          filename: attachments.filename,
          mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes,
          createdAt: attachments.createdAt,
          // El largo del texto, no el texto: lo que importa en la lista es
          // cuánto va a costar arrastrarlo, y el contenido ya está en el chat.
          textChars: sql<number>`coalesce(length(${attachments.extractedText}), 0)::int`,
        })
        .from(attachments)
        .where(eq(attachments.conversationId, conversacion.id))
        .orderBy(asc(attachments.id)),
    };
  }

  /**
   * El canal.
   *
   * `@SSE()` espera un generador: cada valor emitido sale como `data: <json>`.
   * El framework no escribe línea `event:`, así que el tipo viaja dentro del
   * cuerpo — y da igual, porque esto es un POST y `EventSource` no puede
   * leerlo: el cliente lo consume con `fetch` y un lector de stream.
   */
  @Post('/:id/messages')
  @SSE()
  @Roles(ANY_ROLE)
  @UseMiddleware(chatRateLimit)
  async send(
    @Param('id') id: string,
    @Body(SendMessageSchema) body: SendMessageDto,
    @RequestAbortSignal() signal: AbortSignal,
    @Ctx() c: Context,
  ): Promise<AsyncGenerator<ChatEvent>> {
    const { user, conversacion } = await this.propia(c, id);

    // Esto corre antes de que exista el canal, así que un tope alcanzado sale
    // como 402 y no como un 200 con un disgusto adentro.
    await this.chat.prepararTurno(this.db, {
      userId: user.id,
      conversationId: conversacion.id,
      content: body.content,
    });

    const chat = this.chat;
    const db = this.db;

    return (async function* () {
      try {
        yield* chat.responder(db, {
          userId: user.id,
          conversationId: conversacion.id,
          content: body.content,
          signal,
          // El de la petición es el que muere cuando el navegador se va; el
          // del framework hoy solo se dispara por timeout.
          requestSignal: c.req.raw.signal,
        });
      } catch (error) {
        // Con el canal abierto, un error ya no puede ser un 500: las cabeceras
        // se fueron hace rato. Se cuenta por el mismo canal.
        yield {
          type: 'error' as const,
          message: error instanceof Error ? error.message : 'Algo salió mal',
        };
        return;
      }

      await chat.titularSiHaceFalta(db, conversacion.id);
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversacion.id));
    })();
  }
}
