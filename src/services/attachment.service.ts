/**
 * Adjuntos de una conversación.
 *
 * El archivo se guarda, se le saca el texto, y ese texto entra al contexto del
 * modelo. No hay base vectorial: el MVP mete el documento entero y por eso
 * tiene tope. Cuando los documentos no quepan, ahí entra pgvector — que ya está
 * instalado y sin usar a propósito.
 *
 * Dos límites distintos que conviene no confundir:
 *
 *   - lo que pesa el archivo, que es disco
 *   - lo que mide su texto, que es dinero, porque viaja al modelo en cada turno
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Response as HttpResponse, type FileResponse } from 'veloce-ts';

/** 5 MiB. Un PDF con tablas e imágenes llega a eso sin ser raro. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Tope del texto que se extrae, por archivo.
 *
 * 40 000 caracteres son unos 10 000 tokens: con el precio del modelo más caro
 * de la lista, cada turno que lo arrastre cuesta más que una conversación
 * entera. Lo que pasa de aquí se corta y se dice en pantalla.
 */
export const EXTRACTED_TEXT_MAX_CHARS = 40_000;

/** Tope de todo lo adjunto junto, para que diez archivos no sumen diez veces. */
export const CONTEXT_MAX_CHARS = 80_000;

export interface StoredAttachment {
  key: string;
  bytes: number;
  mimeType: string;
  text: string;
  truncado: boolean;
}

export class AttachmentRejectedError extends Error {}

const FIRMAS: Array<{ mimeType: string; ext: string; test: (b: Uint8Array) => boolean }> = [
  {
    mimeType: 'application/pdf',
    ext: 'pdf',
    test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  },
];

/** Las claves que genera este servicio, y nada más: corta el paso a `../`. */
const CLAVE_VALIDA = /^[0-9a-f]{32}\.(pdf|txt|md)$/;

export function claveValida(key: string): boolean {
  return CLAVE_VALIDA.test(key);
}

/**
 * ¿Es texto que una persona escribió?
 *
 * Un .txt no tiene firma: cualquier archivo puede llamarse así. Lo que se
 * comprueba es que sea UTF-8 decodificable y no venga lleno de bytes de
 * control, que es como se ve un binario disfrazado.
 */
function pareceTexto(data: Uint8Array): string | null {
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const control = texto.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
  if (control && control.length > texto.length * 0.01) return null;
  return texto;
}

export class AttachmentService {
  private readonly dir: string;

  constructor(dir = process.env.UPLOADS_DIR ?? './data/uploads') {
    this.dir = resolve(dir);
  }

  private ruta(key: string): string {
    if (!claveValida(key)) throw new AttachmentRejectedError('Clave de archivo inválida');
    return join(this.dir, key);
  }

  /**
   * Guarda el archivo y devuelve su texto.
   *
   * El orden importa: primero se saca el texto y después se escribe en disco.
   * Un PDF que no se puede leer no deja basura guardada.
   */
  async guardar(input: { data: Uint8Array; filename: string }): Promise<StoredAttachment> {
    if (input.data.byteLength === 0) {
      throw new AttachmentRejectedError('El archivo viene vacío');
    }
    if (input.data.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new AttachmentRejectedError('El archivo pesa más de lo permitido');
    }

    const firma = FIRMAS.find((f) => f.test(input.data));
    let texto: string;
    let ext: string;
    let mimeType: string;

    if (firma) {
      texto = await this.textoDePdf(input.data);
      ext = firma.ext;
      mimeType = firma.mimeType;
    } else {
      const plano = pareceTexto(input.data);
      if (plano === null) {
        throw new AttachmentRejectedError('Solo se aceptan PDF, texto plano o Markdown');
      }
      texto = plano;
      ext = input.filename.toLowerCase().endsWith('.md') ? 'md' : 'txt';
      mimeType = ext === 'md' ? 'text/markdown' : 'text/plain';
    }

    const limpio = texto.replace(/\s+\n/g, '\n').trim();
    if (!limpio) {
      throw new AttachmentRejectedError('No se pudo sacar texto de ese archivo');
    }

    const truncado = limpio.length > EXTRACTED_TEXT_MAX_CHARS;
    const final = truncado ? limpio.slice(0, EXTRACTED_TEXT_MAX_CHARS) : limpio;

    await mkdir(this.dir, { recursive: true });
    const key = `${randomUUID().replace(/-/g, '')}.${ext}`;
    await writeFile(this.ruta(key), input.data);

    return { key, bytes: input.data.byteLength, mimeType, text: final, truncado };
  }

  private async textoDePdf(data: Uint8Array): Promise<string> {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const doc = await getDocumentProxy(data);
      const { text } = await extractText(doc, { mergePages: true });
      // Con `mergePages` el tipo declarado ya es string; se acepta igual un
      // arreglo por si la opción cambia, en vez de confiar solo en el tipo.
      return Array.isArray(text) ? (text as string[]).join('\n') : String(text);
    } catch {
      throw new AttachmentRejectedError('Ese PDF no se pudo leer');
    }
  }

  async serve(key: string, filename: string): Promise<FileResponse | null> {
    if (!claveValida(key)) return null;
    try {
      if (!(await stat(this.ruta(key))).isFile()) return null;
    } catch {
      return null;
    }
    const ext = key.slice(key.lastIndexOf('.') + 1);
    const tipos: Record<string, string> = {
      pdf: 'application/pdf',
      txt: 'text/plain; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
    };
    // `fileFrom` ancla la lectura al directorio: salirse lo corta el framework.
    return HttpResponse.fileFrom(this.dir, key, {
      contentType: tipos[ext] ?? 'application/octet-stream',
      filename: nombreSeguro(filename, ext),
    });
  }

  async borrar(key: string): Promise<void> {
    if (!claveValida(key)) return;
    await rm(this.ruta(key), { force: true });
  }

  /** Borra lo que no esté en la lista. Lo usa el reinicio de la demostración. */
  async limpiarSalvo(claves: Iterable<string>): Promise<number> {
    const vivas = new Set(claves);
    let archivos: string[];
    try {
      archivos = await readdir(this.dir);
    } catch {
      return 0;
    }
    const sobran = archivos.filter((n) => claveValida(n) && !vivas.has(n));
    await Promise.all(sobran.map((n) => rm(join(this.dir, n), { force: true })));
    return sobran.length;
  }
}

/** Un nombre de descarga sin comillas ni saltos: va dentro de una cabecera. */
function nombreSeguro(nombre: string, ext: string): string {
  const limpio = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .trim()
    .slice(0, 80);
  const base = limpio || 'documento';
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}
