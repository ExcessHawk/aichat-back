/**
 * Pruebas de humo contra la API corriendo.
 *
 * Lo que se vigila aquí no es que el chat conteste, sino las tres cosas que el
 * plan llamó difíciles: que el stream llegue en pedazos y no de golpe, que
 * cancelar corte la generación de verdad —medido en tokens guardados, no en
 * que la pantalla deje de moverse— y que el tope de gasto se revise antes de
 * llamar al modelo.
 *
 *   bun run dev     # en otra terminal
 *   bun run smoke
 */
import { execFileSync } from 'node:child_process'

const API = process.env.SMOKE_API ?? 'http://localhost:3107'

let ok = 0
let fallos = 0

const check = (nombre, condicion, detalle = '') => {
  if (condicion) {
    ok += 1
    console.log(`  ok   ${nombre}`)
  } else {
    fallos += 1
    console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
  }
}

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', 'aichat_postgres', 'psql', '-U', 'postgres', '-d', 'aichat', '-qtAc', sql],
    { encoding: 'utf8' },
  ).trim()

const call = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = text
  try {
    data = JSON.parse(text)
  } catch {
    /* no era JSON */
  }
  return { status: res.status, data }
}

/**
 * Lee el canal y devuelve los eventos.
 *
 * `cortarEn` cancela la lectura a los N milisegundos, que es lo que hace el
 * botón de parar en el navegador.
 */
const leerCanal = async (path, { token, body, cortarEn } = {}) => {
  const control = new AbortController()
  const eventos = []
  let pedazos = 0
  let timer

  if (cortarEn) timer = setTimeout(() => control.abort(), cortarEn)

  try {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: control.signal,
    })
    if (!res.ok || !res.body) {
      const texto = await res.text()
      return { status: res.status, eventos, pedazos, error: texto }
    }

    const lector = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await lector.read()
      if (done) break
      pedazos += 1
      buffer += decoder.decode(value, { stream: true })
      let corte = buffer.indexOf('\n\n')
      while (corte !== -1) {
        const bloque = buffer.slice(0, corte)
        buffer = buffer.slice(corte + 2)
        corte = buffer.indexOf('\n\n')
        const linea = bloque.split('\n').find((l) => l.startsWith('data:'))
        if (!linea) continue
        try {
          eventos.push(JSON.parse(linea.slice(5).trim()))
        } catch {
          /* bloque incompleto */
        }
      }
    }
    return { status: res.status, eventos, pedazos }
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'abortado', eventos, pedazos }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

console.log(`Humo contra ${API}`)
console.log('')

// ── sesión ────────────────────────────────────────────────────────────────────

const salud = await call('/health')
check('la API responde', salud.status === 200, `status ${salud.status}`)

const sesion = await call('/api/demo/session', { method: 'POST', body: { role: 'usuario' } })
check('la demostración entrega sesión sin contraseña', sesion.status === 200, `status ${sesion.status}`)
const token = sesion.data?.token

const sinRol = await call('/api/demo/session', { method: 'POST', body: { role: 'dios' } })
check('un rol inventado se rechaza', sinRol.status === 422, `status ${sinRol.status}`)

const sinSesion = await call('/api/conversations')
check('sin sesión no se listan conversaciones', sinSesion.status === 401, `status ${sinSesion.status}`)

// ── lo sembrado ───────────────────────────────────────────────────────────────

const lista = await call('/api/conversations', { token })
check('el visitante cae en un mundo con historia', (lista.data?.conversations?.length ?? 0) >= 2,
  `${lista.data?.conversations?.length} conversaciones`)
check(
  'cada conversación trae su cuenta de mensajes',
  (lista.data?.conversations ?? []).every((c) => c.messageCount > 0),
  JSON.stringify((lista.data?.conversations ?? []).map((c) => c.messageCount)),
)
check(
  'y su costo acumulado',
  (lista.data?.conversations ?? []).every((c) => c.costCents > 0),
  JSON.stringify((lista.data?.conversations ?? []).map((c) => c.costCents)),
)

const modelos = await call('/api/models')
check('los modelos son públicos', modelos.status === 200 && modelos.data.models.length >= 2,
  `${modelos.data?.models?.length} modelos`)

// ── el canal ──────────────────────────────────────────────────────────────────

const nueva = await call('/api/conversations', { method: 'POST', token, body: {} })
check('se crea una conversación', nueva.status === 201, `status ${nueva.status}`)
const convId = nueva.data?.id

const canal = await leerCanal(`/api/conversations/${convId}/messages`, {
  token,
  body: { content: '¿Por qué el carrito se vacía solo?' },
})

const tokens = canal.eventos.filter((e) => e.type === 'token')
const uso = canal.eventos.find((e) => e.type === 'usage')
const done = canal.eventos.find((e) => e.type === 'done')

check('la respuesta llega en pedazos', tokens.length > 10, `${tokens.length} eventos de token`)
check(
  'y el cuerpo llega repartido en varias lecturas, no de golpe',
  canal.pedazos > 5,
  `${canal.pedazos} lecturas de red`,
)
check('el canal informa el consumo', Boolean(uso), JSON.stringify(uso))
check('el consumo llega antes del cierre', Boolean(uso && done), 'usage y done')
check(
  'el orden es usage y luego done',
  canal.eventos.findIndex((e) => e.type === 'usage') <
    canal.eventos.findIndex((e) => e.type === 'done'),
)

const texto = tokens.map((t) => t.text).join('')
const guardado = psql(
  `SELECT content FROM messages WHERE id = ${Number(done?.messageId ?? 0)}`,
)
check('lo que se transmitió es lo que se guardó', guardado === texto,
  `${guardado.length} guardados vs ${texto.length} transmitidos`)

const historial = await call(`/api/conversations/${convId}/messages`, { token })
check('el historial trae los dos mensajes', historial.data?.messages?.length === 2,
  `${historial.data?.messages?.length} mensajes`)
check(
  'ninguna fila queda marcada como transmitiendo',
  psql(`SELECT count(*)::int FROM messages WHERE streaming = true`) === '0',
)

const titulada = await call('/api/conversations', { token })
const esta = (titulada.data?.conversations ?? []).find((c) => c.id === convId)
check('la conversación se titula sola', Boolean(esta?.title), JSON.stringify(esta?.title))

// ── cancelar de verdad ────────────────────────────────────────────────────────

const otra = await call('/api/conversations', { method: 'POST', token, body: { model: 'echo-largo' } })
const cortada = await leerCanal(`/api/conversations/${otra.data.id}/messages`, {
  token,
  body: { content: 'Explícame el streaming de tokens con todo detalle, por favor.' },
  cortarEn: 200,
})

check('cortar a los 200 ms deja la respuesta a medias', cortada.status === 'abortado',
  String(cortada.status))

// El servidor necesita un instante para correr su `finally` y guardar.
await new Promise((r) => setTimeout(r, 600))

const fila = psql(`
  SELECT output_tokens || '|' || stopped_by_user || '|' || streaming || '|' || length(content)
    FROM messages
   WHERE conversation_id = ${otra.data.id} AND role = 'assistant'
   ORDER BY id DESC LIMIT 1`)
const [salida, detenido, transmitiendo, largo] = fila.split('|')

check('la respuesta parcial se guardó', Number(largo) > 0, `${largo} caracteres`)
check('queda marcada como detenida por el usuario', detenido === 'true', detenido)
check('y deja de estar marcada como transmitiendo', transmitiendo === 'false', transmitiendo)

// Lo que de verdad prueba que se cortó la generación y no solo la pantalla:
// una respuesta completa de este modelo pasa de 120 tokens de salida.
const completa = psql(`
  SELECT COALESCE(max(output_tokens), 0)::int FROM messages
   WHERE conversation_id = ${convId} AND role = 'assistant'`)
check(
  'se dejaron de producir tokens, no solo de mostrarlos',
  Number(salida) < Number(completa),
  `${salida} tokens cortados vs ${completa} de una completa`,
)

// ── el tope de gasto ──────────────────────────────────────────────────────────

const uso1 = await call('/api/usage', { token })
check('el consumo del periodo se consulta', uso1.status === 200, `status ${uso1.status}`)
check('y trae lo que falta para el tope', typeof uso1.data?.restanteCents === 'number',
  JSON.stringify(uso1.data))

const userId = psql(`SELECT id FROM users WHERE email = 'usuario@demo.chat.mx'`)
psql(`UPDATE usage_limits SET cost_cents = limit_cents WHERE user_id = ${userId}`)

const topado = await call(`/api/conversations/${convId}/messages`, {
  method: 'POST',
  token,
  body: { content: 'Una más' },
})
check('pasado el tope, el modelo no se llama', topado.status === 402, `status ${topado.status}`)

const nuevosMensajes = psql(`
  SELECT count(*)::int FROM messages WHERE conversation_id = ${convId}`)
check('y no se guarda ningún mensaje del intento', nuevosMensajes === '2', `${nuevosMensajes} mensajes`)

psql(`UPDATE usage_limits SET cost_cents = 0 WHERE user_id = ${userId}`)

// ── aislamiento ───────────────────────────────────────────────────────────────

const otraSesion = await call('/api/demo/session', {
  method: 'POST',
  body: { role: 'administrador' },
})
const ajeno = await call(`/api/conversations/${convId}/messages`, {
  token: otraSesion.data?.token,
})
check('una conversación ajena no se lee', ajeno.status === 404, `status ${ajeno.status}`)

console.log('')
console.log(`${ok} de ${ok + fallos} aserciones`)
if (fallos > 0) process.exit(1)
