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


export class GeminiModelProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly models: ModelInfo[];

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    /** Tope duro por respuesta. Lo que no se genera no se paga. */
    private readonly maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 800),
    /** Cuánto puede pensar antes de contestar. Cero lo apaga. */
    private readonly thinkingBudget = Number(process.env.GEMINI_THINKING_BUDGET ?? 0),
  ) {
    if (!apiKey) throw new ModelConfigurationError('Falta GEMINI_API_KEY');
    this.models = modelosDeEntorno();
  }

  private cuerpo(input: StreamInput) {
    return {
      contents: input.messages.map((m) => ({
        // Gemini llama "model" a lo que el resto llama "assistant".
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
      generationConfig: {
        maxOutputTokens: this.maxOutputTokens,
        // Los modelos 3.x piensan antes de contestar, y esos tokens salen del
        // MISMO presupuesto. Con un tope chico el modelo se lo gasta pensando
        // y devuelve una respuesta vacía que igual se cobra. Un presupuesto de
        // cero lo apaga; súbelo si alguna vez interesa el razonamiento.
        thinkingConfig: { thinkingBudget: this.thinkingBudget },
      },
    };
  }

  async *stream(input: StreamInput): AsyncIterable<ModelEvent> {
    const res = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        // La señal llega hasta aquí. Sin esto, cancelar solo cierra el canal
        // con el navegador y el modelo sigue produciendo tokens que ya nadie
        // va a leer, pero que sí se cobran.
        signal: input.signal,
        body: JSON.stringify(this.cuerpo(input)),
      },
    );

    if (!res.ok || !res.body) {
      const detalle = await res.text().catch(() => '');
      throw new Error(
        `El modelo respondió ${res.status}${detalle ? `: ${detalle.slice(0, 200)}` : ''}`,
      );
    }

    const lector = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let motivo = '';
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

        const partes = evento.candidates?.[0]?.content?.parts;
        if (Array.isArray(partes)) {
          for (const parte of partes) {
            if (typeof parte?.text === 'string' && parte.text) {
              yield { type: 'text', text: parte.text };
            }
          }
        }

        // El uso llega en cada trozo y se va actualizando; el último manda.
        const meta = evento.usageMetadata;
        if (meta) {
          usage.inputTokens = meta.promptTokenCount ?? usage.inputTokens;
          usage.outputTokens = meta.candidatesTokenCount ?? usage.outputTokens;
        }

        const razon = evento.candidates?.[0]?.finishReason;
        if (typeof razon === 'string') motivo = razon;
      }
    }

    // Si el proveedor no contó, se estima: un contador en cero haría que el
    // tope de gasto no frenara nunca.
    if (usage.inputTokens === 0) {
      usage.inputTokens = approximateTokens(input.messages.map((m) => m.content).join(' '));
    }
    yield { type: 'usage', usage };
    if (motivo) yield { type: 'fin', motivo };
  }

  async title(input: { model: string; messages: ModelMessage[] }): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          contents: input.messages.slice(0, 2).map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          systemInstruction: {
            parts: [
              {
                text: 'Devuelve un título de máximo seis palabras para esta conversación. Sin comillas, sin punto final.',
              },
            ],
          },
          generationConfig: { maxOutputTokens: 24 },
        }),
      },
    );
    if (!res.ok) throw new Error(`El modelo respondió ${res.status} al titular`);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Conversación').trim().slice(0, 60);
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
