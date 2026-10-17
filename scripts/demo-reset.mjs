/**
 * Borra lo que hicieron los visitantes y deja la demostración como recién
 * sembrada. Es lo que corre el cron cada hora, junto con demo:seed.
 *
 * Solo toca filas que cuelgan de cuentas @demo.chat.mx, se niega a correr sin
 * DEMO_MODE, y aborta si encuentra una cuenta marcada is_demo fuera de ese
 * dominio — eso significaría que alguien marcó a una persona real.
 *
 *   bun run demo:reset
 */
import { Client } from 'pg'

const DOMAIN = '@demo.chat.mx'
const FORCE = process.argv.includes('--force')

if (process.env.DEMO_MODE !== 'true' && !FORCE) {
  console.error('DEMO_MODE no está en true. Este script solo corre contra la base de demostración.')
  console.error('Si de verdad quieres correrlo aquí, pasa --force.')
  process.exit(1)
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Corre con bun, que lee el .env solo.')
  process.exit(1)
}

const client = new Client({ connectionString: DATABASE_URL })
await client.connect()

const q = async (sql, params = []) => (await client.query(sql, params)).rowCount ?? 0

const demoUsers = `(SELECT id FROM users WHERE email LIKE '%${DOMAIN}' AND is_demo = true)`

const { rows: cuenta } = await client.query(
  `SELECT count(*)::int AS n FROM users WHERE email LIKE '%${DOMAIN}' AND is_demo = true`,
)
if (cuenta[0].n === 0) {
  console.error('No hay cuentas de demostración. Siembra primero con demo:seed.')
  process.exit(1)
}

const { rows: ajenas } = await client.query(
  `SELECT count(*)::int AS n FROM users WHERE is_demo = true AND email NOT LIKE '%${DOMAIN}'`,
)
if (ajenas[0].n !== 0) {
  console.error(`${ajenas[0].n} cuenta(s) marcadas is_demo fuera del dominio de demostración.`)
  console.error('Eso no debería pasar. Revísalas antes de borrar nada.')
  process.exit(1)
}

console.log(`Reiniciando la demostración (${cuenta[0].n} cuentas)`)

const pasos = [
  // Las conversaciones se van enteras: los mensajes y los adjuntos cuelgan de
  // ellas en cascada.
  ['conversaciones y sus mensajes', `DELETE FROM conversations WHERE user_id IN ${demoUsers}`],
  ['consumo del periodo', `DELETE FROM usage_limits WHERE user_id IN ${demoUsers}`],
  ['sesiones abiertas', `DELETE FROM refresh_tokens WHERE user_id IN ${demoUsers}`],
  ['bitácora', `DELETE FROM audit_logs WHERE user_id IN ${demoUsers}`],
  [
    'cuentas que creó un visitante',
    `DELETE FROM users WHERE is_demo = false AND email LIKE '%${DOMAIN}'`,
  ],
]

for (const [etiqueta, sql] of pasos) {
  const n = await q(sql)
  console.log(`  limpio: ${etiqueta}${n ? ` (${n})` : ''}`)
}

console.log('')
console.log('Listo. Corre demo:seed para volver a poblarla.')

await client.end()
