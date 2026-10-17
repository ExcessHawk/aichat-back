/**
 * El modelo, detrás de una interfaz.
 *
 * Misma forma que `PaymentProvider` en el marketplace: una interfaz y dos
 * adaptadores. El de verdad llama a la API de Anthropic; el falso inventa la
 * respuesta sin salir del proceso.
 *
 * El falso no es un atajo de desarrollo: es lo que corre en la demostración
 * pública. Una demo abierta conectada a un modelo que se paga por token es una
 * factura esperando a que alguien la encuentre.
 */

export interface ModelInfo {
  id: string;
  label: string;
  /** Precio en centavos de dólar por millón de tokens. */
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: ModelUsage }
  /**
   * Por qué terminó la respuesta, en las palabras del proveedor.
   *
   * Importa cuando no llegó texto: una respuesta vacía y cobrada necesita
   * explicarse, y la explicación la tiene el proveedor, no nosotros.
   */
  | { type: 'fin'; motivo: string };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamInput {
  model: string;
  system?: string | null;
  messages: ModelMessage[];
  signal: AbortSignal;
}

export interface ModelProvider {
  readonly name: string;
  readonly models: ModelInfo[];
  stream(input: StreamInput): AsyncIterable<ModelEvent>;
  /** Un título corto para la conversación, a partir del primer intercambio. */
  title(input: { model: string; messages: ModelMessage[] }): Promise<string>;
}

export class ModelConfigurationError extends Error {}

/**
 * El mensaje de un error del proveedor, en limpio.
 *
 * Lo que devuelven estas APIs es un JSON anidado con enlaces de consola y
 * metadatos. Volcarlo entero en la burbuja del chat le enseña a un visitante
 * un objeto en crudo; lo que sirve es la frase de dentro.
 */
export function mensajeDeError(crudo: string): string {
  try {
    const datos = JSON.parse(crudo);
    const mensaje = datos?.error?.message ?? datos?.message;
    if (typeof mensaje === 'string' && mensaje.trim()) {
      // Las frases de Google terminan en una URL de consola larguísima que no
      // le dice nada a quien está mirando el chat.
      return mensaje.split(/\s*(?:Visita|Enable it by visiting|visiting)\s+https?:\/\//)[0].trim().slice(0, 240);
    }
  } catch {
    /* no era JSON: se usa tal cual */
  }
  return crudo.slice(0, 240);
}

/** Lo que cuesta una respuesta, redondeado hacia arriba al centavo. */
export function costInCents(model: ModelInfo, usage: ModelUsage): number {
  const cents =
    (usage.inputTokens * model.inputCentsPerMillion) / 1_000_000 +
    (usage.outputTokens * model.outputCentsPerMillion) / 1_000_000;
  return Math.ceil(cents);
}

/**
 * Cuenta de tokens aproximada.
 *
 * Sirve para el adaptador falso y para estimar el costo *antes* de llamar al
 * modelo, que es donde se revisa el límite. La cuenta buena la da el proveedor
 * al terminar, y es la que se guarda.
 */
export function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// ─── Adaptador falso ──────────────────────────────────────────────────────────

const RESPUESTAS = [
  'Vamos por partes. {tema} tiene tres caras que conviene separar antes de decidir nada: qué problema resuelve, qué cuesta mantenerlo y qué se rompe cuando crece.\n\nLo primero es lo más fácil de contestar y lo que menos se pregunta.',
  'La respuesta corta es que depende de dónde esté el cuello de botella. Sobre {tema}, lo que suele pasar es que el problema no está donde se mira.\n\nUn ejemplo:\n\n```ts\n// Lo que parece el problema\nconst datos = await cargarTodo()\n// Lo que lo es de verdad\nfor (const x of datos) await guardar(x)\n```\n\nEl bucle hace una ida y vuelta por fila.',
  'Sobre {tema}: lo que importa no es la herramienta sino la invariante que quieres proteger. Si no puedes escribirla en una frase, ninguna herramienta te va a salvar de romperla.',
  'Buena pregunta. {tema} se entiende mejor al revés: en vez de preguntar qué hace, preguntar qué deja de ser posible cuando está puesto.\n\nEso suele dejar una lista corta, y la lista corta es la decisión.',
];

export class EchoModelProvider implements ModelProvider {
  readonly name = 'echo';
  readonly models: ModelInfo[] = [
    {
      id: 'echo-rapido',
      label: 'Echo rápido (demostración)',
      inputCentsPerMillion: 300,
      outputCentsPerMillion: 1500,
    },
    {
      id: 'echo-largo',
      label: 'Echo extenso (demostración)',
      inputCentsPerMillion: 1500,
      outputCentsPerMillion: 7500,
    },
  ];

  constructor(private readonly msPorPedazo = 18) {}

  async *stream(input: StreamInput): AsyncIterable<ModelEvent> {
    const ultima = [...input.messages].reverse().find((m) => m.role === 'user');
    const tema = (ultima?.content ?? 'eso').trim().slice(0, 60).replace(/\s+/g, ' ');

    // Los documentos adjuntos llegan en el `system`. Un modelo falso que los
    // ignorara haría que adjuntar algo se viera inerte en la demostración, y
    // que una prueba no pudiera distinguir "llegó" de "no llegó".
    const nombres = [...(input.system ?? '').matchAll(/<documento nombre="([^"]+)">/g)].map(
      (m) => m[1],
    );

    // Determinista a partir de la pregunta: la misma entrada da la misma
    // respuesta, que es lo que hace posible probarlo.
    const indice = [...tema].reduce((n, c) => n + c.charCodeAt(0), 0) % RESPUESTAS.length;
    const largo = input.model === 'echo-largo' ? 2 : 1;
    const texto = Array.from({ length: largo }, () => RESPUESTAS[indice].replace('{tema}', tema))
      .join('\n\n');

    const conDocumentos = nombres.length
      ? `Con ${nombres.length === 1 ? 'el documento' : 'los documentos'} a la vista (${nombres.join(', ')}): ${texto}`
      : texto;

    const pedazos = conDocumentos.match(/\s*\S+/g) ?? [conDocumentos];
    let salida = 0;

    for (const pedazo of pedazos) {
      // Abortar no es "dejar de emitir": es dejar de producir. Aquí el bucle
      // termina y el llamador guarda lo que alcanzó a acumular.
      if (input.signal.aborted) break;
      await new Promise((r) => setTimeout(r, this.msPorPedazo));
      if (input.signal.aborted) break;
      salida += approximateTokens(pedazo);
      yield { type: 'text', text: pedazo };
    }

    yield {
      type: 'usage',
      usage: {
        inputTokens: approximateTokens(input.messages.map((m) => m.content).join(' ')),
        outputTokens: salida,
      },
    };
  }

  async title(input: { messages: ModelMessage[] }): Promise<string> {
    const primera = input.messages.find((m) => m.role === 'user')?.content ?? 'Conversación';
    const limpio = primera.trim().replace(/\s+/g, ' ');
    return limpio.length > 48 ? `${limpio.slice(0, 45)}…` : limpio;
  }
}

// ─── Adaptador de Anthropic ───────────────────────────────────────────────────

const MODELOS_ANTHROPIC: ModelInfo[] = [
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    inputCentsPerMillion: 300,
    outputCentsPerMillion: 1500,
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    inputCentsPerMillion: 80,
    outputCentsPerMillion: 400,
  },
];

export class AnthropicModelProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly models = MODELOS_ANTHROPIC;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {
    if (!apiKey) throw new ModelConfigurationError('Falta ANTHROPIC_API_KEY');
  }

  async *stream(input: StreamInput): AsyncIterable<ModelEvent> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      // La señal llega hasta aquí. Sin esto, cancelar solo cierra el canal con
      // el navegador y el modelo sigue produciendo tokens que ya nadie paga por
      // leer, pero que sí se cobran.
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1024,
        stream: true,
        ...(input.system ? { system: input.system } : {}),
        messages: input.messages,
      }),
    });

    if (!res.ok || !res.body) {
      const detalle = await res.text().catch(() => '');
      throw new Error(`El modelo respondió ${res.status}${detalle ? `: ${detalle.slice(0, 200)}` : ''}`);
    }

    const lector = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };

    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // El canal manda bloques separados por línea en blanco.
      let corte = buffer.indexOf('\n\n');
      while (corte !== -1) {
        const bloque = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        corte = buffer.indexOf('\n\n');

        const linea = bloque.split('\n').find((l) => l.startsWith('data:'));
        if (!linea) continue;
        const crudo = linea.slice(5).trim();
        if (!crudo || crudo === '[DONE]') continue;

        let evento: Record<string, any>;
        try {
          evento = JSON.parse(crudo);
        } catch {
          continue;
        }

        if (evento.type === 'content_block_delta' && evento.delta?.type === 'text_delta') {
          yield { type: 'text', text: evento.delta.text as string };
        } else if (evento.type === 'message_start') {
          usage.inputTokens = evento.message?.usage?.input_tokens ?? 0;
        } else if (evento.type === 'message_delta') {
          usage.outputTokens = evento.usage?.output_tokens ?? usage.outputTokens;
        }
      }
    }

    yield { type: 'usage', usage };
  }

  async title(input: { model: string; messages: ModelMessage[] }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 24,
        system:
          'Devuelve un título de máximo seis palabras para esta conversación. Sin comillas, sin punto final.',
        messages: input.messages.slice(0, 2),
      }),
    });
    if (!res.ok) throw new Error(`El modelo respondió ${res.status} al titular`);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return (data.content?.[0]?.text ?? 'Conversación').trim().slice(0, 60);
  }
}

// ─── Adaptador de Gemini ──────────────────────────────────────────────────────

/**
 * Precios en centavos de dólar por millón de tokens.
 *
 * Los precios de los modelos cambian, y un número viejo aquí no rompe nada
 * ruidosamente: solo hace que el contador y el tope mientan. Por eso se pueden
 * ajustar por entorno sin tocar código, y conviene revisarlos contra la página
 * de precios de Google de vez en cuando.
 */
/**
 * Qué modelos ofrece Gemini, leídos del entorno.
 *
 * Estaban escritos en el código y Google retiró uno: la demostración empezó a
 * contestar "This model is no longer available" y hacía falta un despliegue
 * para algo que es configuración. Ahora se declaran así, separados por comas:
 *
 *   GEMINI_MODELS="id:Etiqueta:centavosEntrada:centavosSalida,otro:..."
 *
 * Los centavos son por millón de tokens y son lo que alimenta el contador y el
 * tope de gasto. Si envejecen, el tope miente sin avisar.
 *
 * Para ver qué ofrece de verdad tu llave: `bun run models:gemini`.
 */
function modelosDeEntorno(): ModelInfo[] {
  const crudo = process.env.GEMINI_MODELS?.trim();
  if (!crudo) {
    return [
      {
        id: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
        label: process.env.GEMINI_MODEL_LABEL ?? 'Gemini 3.8 Flash',
        inputCentsPerMillion: Number(process.env.GEMINI_FLASH_IN_CENTS ?? 30),
        outputCentsPerMillion: Number(process.env.GEMINI_FLASH_OUT_CENTS ?? 250),
      },
    ];
  }

  const modelos = crudo
    .split(',')
    .map((trozo) => trozo.trim())
    .filter(Boolean)
    .map((trozo) => {
      const [id, label, entrada, salida] = trozo.split(':').map((x) => x.trim());
      if (!id) return null;
      return {
        id,
        label: label || id,
        inputCentsPerMillion: Number(entrada ?? 30) || 30,
        outputCentsPerMillion: Number(salida ?? 250) || 250,
      } satisfies ModelInfo;
    })
    .filter((m): m is ModelInfo => m !== null);

  if (modelos.length === 0) {
    throw new ModelConfigurationError('GEMINI_MODELS está puesto pero no declara ningún modelo');
  }
  return modelos;
}


/**
 * Gemini por la API de Interacciones.
 *
 * No es `models/x:streamGenerateContent`: esa es la generación de contenido de
 * antes, y contra un modelo 3.x devolvía doscientos con el canal vacío —
 * aceptaba la petición y no escribía una palabra. Esta API habla de pasos
 * (`user_input`, `thought`, `model_output`) en vez de roles, y exige la
 * cabecera de revisión.
 *
 * Se trabaja sin estado (`store: false`): la conversación vive en nuestra base
 * y viaja entera en cada turno. Guardarla también del lado de Google sería
 * tener la misma verdad en dos sitios.
 */
export class GeminiModelProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly models: ModelInfo[];

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.GEMINI_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta',
    /**
     * Tope duro por respuesta. Aquí cabe también lo que el modelo piense antes
     * de escribir: quedarse corto hace que gaste todo razonando y conteste
     * vacío.
     */
    private readonly maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 2048),
    /**
     * Cuánto razona antes de contestar: "low", "medium", "high". Vacío deja
     * que lo decida el modelo.
     */
    private readonly thinkingLevel = process.env.GEMINI_THINKING_LEVEL ?? '',
    /** La API versiona por cabecera, no por ruta. */
    private readonly apiRevision = process.env.GEMINI_API_REVISION ?? '2026-05-20',
  ) {
    if (!apiKey) throw new ModelConfigurationError('Falta GEMINI_API_KEY');
    this.models = modelosDeEntorno();
  }

  private cabeceras() {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
      'Api-Revision': this.apiRevision,
    };
  }

  /** El historial como pasos. Lo que aquí se llama rol, allá es tipo de paso. */
  private pasos(messages: ModelMessage[]) {
    return messages.map((m) => ({
      type: m.role === 'assistant' ? 'model_output' : 'user_input',
      content: [{ type: 'text', text: m.content }],
    }));
  }

  private cuerpo(input: StreamInput, stream: boolean) {
    return {
      model: input.model,
      input: this.pasos(input.messages),
      stream,
      // La conversación ya vive en nuestra base; no hace falta una segunda
      // copia del otro lado.
      store: false,
      ...(input.system ? { system_instruction: input.system } : {}),
      generation_config: {
        max_output_tokens: this.maxOutputTokens,
        // Los modelos 3.6 en adelante ignoran temperature, top_p y top_k, y
        // devuelven avisos de obsolescencia si se mandan. No se mandan.
        ...(this.thinkingLevel ? { thinking_level: this.thinkingLevel } : {}),
      },
    };
  }

  async *stream(input: StreamInput): AsyncIterable<ModelEvent> {
    const res = await fetch(`${this.baseUrl}/interactions?alt=sse`, {
      method: 'POST',
      headers: this.cabeceras(),
      // La señal llega hasta aquí. Sin esto, cancelar solo cierra el canal con
      // el navegador y el modelo sigue produciendo tokens que ya nadie va a
      // leer, pero que sí se cobran.
      signal: input.signal,
      body: JSON.stringify(this.cuerpo(input, true)),
    });

    if (!res.ok || !res.body) {
      const detalle = await res.text().catch(() => '');
      // El log se queda con todo; la burbuja, solo con la frase.
      if (detalle) console.error(`Gemini ${res.status}: ${detalle.slice(0, 600)}`);
      throw new Error(
        `El modelo respondió ${res.status}${detalle ? `: ${mensajeDeError(detalle)}` : ''}`,
      );
    }

    const lector = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let motivo = '';
    let ultimoBloque = '';
    let hubotexto = false;
    /** Qué es cada paso por su índice: un `thought` no es la respuesta. */
    const tipoDePaso = new Map<number, string>();
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };

    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let corte = buffer.indexOf('\n\n');
      while (corte !== -1) {
        const bloque = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        corte = buffer.indexOf('\n\n');

        const linea = bloque.split('\n').find((l) => l.startsWith('data:'));
        if (!linea) continue;
        const crudo = linea.slice(5).trim();
        if (!crudo || crudo === '[DONE]') continue;

        let evento: Record<string, any>;
        try {
          evento = JSON.parse(crudo);
        } catch {
          continue;
        }

        ultimoBloque = crudo;

        // Google puede mandar su propio error DENTRO del canal, con las
        // cabeceras ya enviadas. Sin esto se vería como una respuesta vacía.
        if (evento.error?.message) {
          console.error(`Gemini mandó un error por el canal: ${crudo.slice(0, 600)}`);
          throw new Error(`El modelo respondió: ${mensajeDeError(crudo)}`);
        }

        switch (evento.event_type) {
          case 'step.start':
            if (typeof evento.index === 'number') {
              tipoDePaso.set(evento.index, evento.step?.type ?? '');
            }
            break;

          case 'step.delta': {
            // Los pasos de razonamiento también emiten deltas, pero de firma,
            // no de texto. Solo se escribe lo que el modelo quiso decir.
            const esTexto = evento.delta?.type === 'text' && typeof evento.delta.text === 'string';
            const paso = tipoDePaso.get(evento.index) ?? 'model_output';
            if (esTexto && paso !== 'thought' && evento.delta.text) {
              hubotexto = true;
              yield { type: 'text', text: evento.delta.text };
            }
            break;
          }

          case 'interaction.completed': {
            const uso = evento.interaction?.usage;
            if (uso) {
              usage.inputTokens = uso.total_input_tokens ?? usage.inputTokens;
              usage.outputTokens = uso.total_output_tokens ?? usage.outputTokens;
              // En streaming a veces solo llega el total: lo que falta se
              // deduce en vez de quedarse en cero, que haría que el tope de
              // gasto no frenara nunca.
              if (!usage.outputTokens && uso.total_tokens) {
                usage.outputTokens = Math.max(0, uso.total_tokens - usage.inputTokens);
              }
            }
            motivo = evento.interaction?.status ?? motivo;
            break;
          }
        }
      }
    }

    if (usage.inputTokens === 0) {
      usage.inputTokens = approximateTokens(input.messages.map((m) => m.content).join(' '));
    }

    // Si no llegó texto, lo que Google mandó al final es la única pista. Se
    // registra recortado para que el log diga algo y no haya que adivinar.
    if (!hubotexto) {
      console.warn(
        `Gemini no devolvió texto (modelo "${input.model}", estado "${motivo || 'sin estado'}"). Último bloque: ${ultimoBloque.slice(0, 400)}`,
      );
    }

    yield { type: 'usage', usage };
    if (motivo && motivo !== 'completed') yield { type: 'fin', motivo };
  }

  async title(input: { model: string; messages: ModelMessage[] }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/interactions`, {
      method: 'POST',
      headers: this.cabeceras(),
      body: JSON.stringify({
        model: input.model,
        input: this.pasos(input.messages.slice(0, 2)),
        store: false,
        system_instruction:
          'Devuelve un título de máximo seis palabras para esta conversación. Sin comillas, sin punto final.',
        generation_config: { max_output_tokens: 64 },
      }),
    });
    if (!res.ok) throw new Error(`El modelo respondió ${res.status} al titular`);

    const data = (await res.json()) as {
      steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    // La respuesta viene en pasos, y antes del texto puede haber uno de
    // razonamiento: se busca el de salida, no el primero.
    const salida = (data.steps ?? []).find((p) => p.type === 'model_output');
    const texto = (salida?.content ?? []).find((c) => c.type === 'text')?.text;
    return (texto ?? 'Conversación').trim().slice(0, 60);
  }
}

/**
 * Cuál se usa.
 *
 * Sin llave, el falso. Con llave y `MODEL_PROVIDER=anthropic`, el de verdad.
 * El orden importa: pedir el real sin llave tiene que fallar al arrancar y no
 * a medio chat.
 */
export function createModelProvider(): ModelProvider {
  const elegido = process.env.MODEL_PROVIDER ?? 'echo';
  if (elegido === 'anthropic') {
    return new AnthropicModelProvider(process.env.ANTHROPIC_API_KEY ?? '');
  }
  if (elegido === 'gemini') {
    return new GeminiModelProvider(process.env.GEMINI_API_KEY ?? '');
  }
  return new EchoModelProvider(Number(process.env.ECHO_CHUNK_MS ?? 18));
}
