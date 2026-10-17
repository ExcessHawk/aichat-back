/**
 * Siembra la demostración.
 *
 * Un demo vacío no enseña nada: el visitante tiene que caer en un mundo con
 * historia y poder seguir desde ahí. Aquí eso son dos conversaciones con sus
 * mensajes, los tokens ya contados y el consumo del periodo visible.
 *
 *   bun run demo:seed
 */
import { hash as argonHash } from '@node-rs/argon2'
import { Client } from 'pg'

const DOMAIN = '@demo.chat.mx'
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demostracion-sin-datos-reales'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Corre con bun, que lee el .env solo.')
  process.exit(1)
}

const client = new Client({ connectionString: DATABASE_URL })
await client.connect()

console.log('Sembrando la demostración')
console.log(`  base: ${DATABASE_URL.replace(/\/\/[^@]+@/, '//***@')}`)

const hash = await argonHash(PASSWORD)

async function cuenta(email, fullName, role) {
  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, full_name, role, is_demo)
          VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (lower(email)) DO UPDATE
            SET full_name = EXCLUDED.full_name,
                role = EXCLUDED.role,
                is_demo = true
       RETURNING id`,
    [email, hash, fullName, role],
  )
  return rows[0].id
}

const usuario = await cuenta(`usuario${DOMAIN}`, 'Alex Visitante', 'user')
const admin = await cuenta(`admin${DOMAIN}`, 'Quien administra', 'admin')
console.log('  2 cuentas de demostración')

/**
 * Las conversaciones sembradas.
 *
 * El texto del asistente está escrito a mano, no generado: la demostración
 * tiene que verse igual cada vez que alguien entra, y una respuesta inventada
 * al vuelo haría que la captura de pantalla de hoy no se parezca a la de
 * mañana.
 */
const CONVERSACIONES = [
  {
    title: 'Por qué el carrito se vacía solo',
    model: 'echo-rapido',
    turnos: [
      [
        'Tengo un carrito que se vacía solo cada cierto tiempo y no encuentro dónde.',
        'Hay tres sospechosos habituales y conviene descartarlos en orden.\n\nEl primero es la sesión: si el carrito cuelga de una sesión en memoria y el proceso se reinicia, el carrito se va con él y no queda rastro en ningún log.\n\nEl segundo es un borrado en cascada. Si `cart_items` referencia algo que se borra —una variante, una cuenta de vendedor—, la cascada se lleva la fila del comprador sin que nadie haya tocado su carrito.\n\nEl tercero, y el más difícil de ver, es un trabajo de limpieza con un `WHERE` más ancho de lo que su autor creía.',
      ],
      [
        'Era la cascada. ¿Cómo lo hago visible antes de que pase?',
        'Con una bitácora que no dependa del código que borra. Un disparador sobre `cart_items` que escriba en una tabla de auditoría quién y qué, y después revisar esa tabla cuando alguien se queje.\n\nLo importante es que el disparador viva en la base y no en la aplicación: una cascada no pasa por tu código, así que un log escrito desde la aplicación nunca la va a ver.',
      ],
    ],
  },
  {
    title: 'Streaming sin que la interfaz se trabe',
    model: 'echo-largo',
    turnos: [
      [
        '¿Por qué se traba el chat cuando llegan muchos tokens seguidos?',
        'Porque cada token que entra al estado de React es un render, y un render por carácter es más trabajo del que cabe en un cuadro de 16 ms.\n\nLo que se hace es agrupar: los pedazos que llegan se acumulan en un `useRef`, y un `requestAnimationFrame` los vuelca al estado una vez por cuadro. La diferencia se nota de inmediato, porque el navegador deja de pintar cuarenta veces lo mismo.\n\nEl detalle que se olvida: al terminar hay que volcar lo que quedó en el buffer. Si no, la última palabra de cada respuesta se queda sin aparecer.',
      ],
    ],
  },
]

// Idempotente: si ya están, no se duplican.
const { rows: existentes } = await client.query(
  `SELECT count(*)::int AS n FROM conversations WHERE user_id = $1`,
  [usuario],
)

if (existentes[0].n === 0) {
  for (const conv of CONVERSACIONES) {
    const { rows } = await client.query(
      `INSERT INTO conversations (user_id, title, model) VALUES ($1, $2, $3) RETURNING id`,
      [usuario, conv.title, conv.model],
    )
    const conversationId = rows[0].id

    for (const [pregunta, respuesta] of conv.turnos) {
      const entrada = Math.ceil(pregunta.length / 4)
      const salida = Math.ceil(respuesta.length / 4)
      // Mismo precio que declara el proveedor falso para ese modelo.
      const precioSalida = conv.model === 'echo-largo' ? 7500 : 1500
      const costo = Math.ceil((entrada * 300) / 1_000_000 + (salida * precioSalida) / 1_000_000)

      await client.query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
        [conversationId, pregunta],
      )
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, input_tokens, output_tokens, cost_cents, model)
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
        [conversationId, respuesta, entrada, salida, costo, conv.model],
      )
    }
  }
  console.log(`  ${CONVERSACIONES.length} conversaciones con su historia`)
} else {
  console.log(`  ${existentes[0].n} conversaciones ya estaban`)
}

// El consumo del periodo, calculado de los mensajes para que cuadre con lo que
// se ve en pantalla.
const periodo = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
for (const userId of [usuario, admin]) {
  const { rows } = await client.query(
    `SELECT COALESCE(sum(m.input_tokens), 0)::int  AS entrada,
            COALESCE(sum(m.output_tokens), 0)::int AS salida,
            COALESCE(sum(m.cost_cents), 0)::int    AS costo
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = $1`,
    [userId],
  )
  const { entrada, salida, costo } = rows[0]
  await client.query(
    `INSERT INTO usage_limits (user_id, period_start, input_tokens, output_tokens, cost_cents, limit_cents)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, period_start) DO UPDATE
            SET input_tokens = EXCLUDED.input_tokens,
                output_tokens = EXCLUDED.output_tokens,
                cost_cents = EXCLUDED.cost_cents`,
    [userId, periodo, entrada, salida, costo, Number(process.env.USAGE_LIMIT_CENTS ?? 200)],
  )
}
console.log('  consumo del periodo puesto al día')

console.log('')
console.log('Listo. Cuentas de demostración:')
console.log(`  usuario        usuario${DOMAIN}`)
console.log(`  administrador  admin${DOMAIN}`)
console.log('')
console.log('La contraseña no se usa desde el portafolio: POST /api/demo/session entrega la')
console.log('sesión. Ese endpoint solo existe cuando DEMO_MODE=true.')

await client.end()
