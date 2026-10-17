/**
 * Adjuntos: subir, listar, descargar y quitar.
 *
 * Todo cuelga de una conversación, y una conversación es de una persona, así
 * que cada ruta comprueba la pertenencia. Un documento adjunto puede traer
 * cualquier cosa dentro; no se sirve en abierto a quien adivine una clave.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  BadRequestException,
  Controller,
  Ctx,
  Delete,
  Get,
  Inject,
  InjectDB,
  NotFoundException,
  Param,
  Post,
  Roles,
  UseMiddleware,
} from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { attachments, conversations } from '../db/schema';
import { ANY_ROLE, requireUser } from '../auth/current-user';
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentRejectedError,
  AttachmentService,
} from '../services/attachment.service';
import { uploadRateLimit } from '../middleware/rate-limit.middleware';

@Controller('/api/attachments')
export class AttachmentsController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(AttachmentService) private archivos: AttachmentService,
  ) {}

  private async conversacionPropia(c: Context, conversationId: number) {
    const user = requireUser(c);
    const [fila] = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, user.id),
          isNull(conversations.deletedAt),
        ),
      );
    if (!fila) throw new NotFoundException('Esa conversación no existe');
    return fila;
  }

  private async adjuntoPropio(c: Context, id: number) {
    const [adjunto] = await this.db.select().from(attachments).where(eq(attachments.id, id));
    if (!adjunto) throw new NotFoundException('Ese adjunto no existe');
    await this.conversacionPropia(c, adjunto.conversationId);
    return adjunto;
  }

  @Post('/')
  @Roles(ANY_ROLE)
  @UseMiddleware(uploadRateLimit)
  async upload(@Ctx() c: Context) {
    const tipo = c.req.header('content-type') ?? '';
    if (!tipo.toLowerCase().includes('multipart/form-data')) {
      throw new BadRequestException('Manda el archivo como multipart/form-data');
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new BadRequestException('No se pudo leer el formulario');
    }

    const conversationId = Number(form.get('conversationId'));
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new BadRequestException('Falta la conversación');
    }
    const conversacion = await this.conversacionPropia(c, conversationId);

    const archivo = form.get('file');
    if (!(archivo instanceof File)) throw new BadRequestException('Falta el campo "file"');
    if (archivo.size > ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException(
        `El archivo pesa ${Math.ceil(archivo.size / 1024)} kB y el límite son ${ATTACHMENT_MAX_BYTES / 1024} kB`,
      );
    }

    const data = new Uint8Array(await archivo.arrayBuffer());

    let guardado;
    try {
      guardado = await this.archivos.guardar({ data, filename: archivo.name });
    } catch (error) {
      if (error instanceof AttachmentRejectedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const [fila] = await this.db
      .insert(attachments)
      .values({
        conversationId: conversacion.id,
        filename: archivo.name.slice(0, 255),
        mimeType: guardado.mimeType,
        sizeBytes: guardado.bytes,
        storageKey: guardado.key,
        extractedText: guardado.text,
      })
      .returning();

    c.status(201);
    return {
      id: fila.id,
      filename: fila.filename,
      mimeType: fila.mimeType,
      sizeBytes: fila.sizeBytes,
      createdAt: fila.createdAt,
      /** Lo que de verdad va a viajar al modelo, que no es lo que pesa. */
      textChars: guardado.text.length,
      truncado: guardado.truncado,
    };
  }

  @Get('/:id/file')
  @Roles(ANY_ROLE)
  async file(@Param('id') id: string, @Ctx() c: Context) {
    const adjunto = await this.adjuntoPropio(c, Number(id));
    const respuesta = await this.archivos.serve(adjunto.storageKey, adjunto.filename);
    if (!respuesta) throw new NotFoundException('El archivo ya no está');
    return respuesta;
  }

  @Delete('/:id')
  @Roles(ANY_ROLE)
  async remove(@Param('id') id: string, @Ctx() c: Context) {
    const adjunto = await this.adjuntoPropio(c, Number(id));
    await this.db.delete(attachments).where(eq(attachments.id, adjunto.id));
    await this.archivos.borrar(adjunto.storageKey);
    return { message: 'Adjunto quitado' };
  }
}
