/**
 * Qué modelos ofrece de verdad tu llave de Gemini.
 *
 * Escribir la lista a mano envejece: Google retira modelos y la demostración
 * se entera contestando "This model is no longer available" a un visitante.
 * Esto pregunta en vez de adivinar, y además imprime la línea lista para
 * pegar en api.env.
 *
 *   bun run models:gemini
 */
const KEY = process.env.GEMINI_API_KEY
if (!KEY) {
  console.error('Falta GEMINI_API_KEY. Corre con bun, que lee el .env solo.')
  process.exit(1)
}

const BASE = process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta'

const res = await fetch(`${BASE}/models?pageSize=200`, {
  headers: { 'x-goog-api-key': KEY },
})

if (!res.ok) {
  console.error(`Google respondió ${res.status}`)
  console.error((await res.text()).slice(0, 400))
  process.exit(1)
}

const { models = [] } = await res.json()

/** Solo los que sirven para chatear; el resto son de embeddings u otras cosas. */
const utiles = models.filter((m) =>
  (m.supportedGenerationMethods ?? []).includes('streamGenerateContent'),
)

if (utiles.length === 0) {
  console.error('Ninguno de los modelos de esta llave admite streamGenerateContent.')
  process.exit(1)
}

console.log(`${utiles.length} modelo(s) con streaming:`)
console.log('')
for (const m of utiles) {
  const id = m.name.replace(/^models\//, '')
  const entrada = m.inputTokenLimit ? `${m.inputTokenLimit.toLocaleString('es-MX')} de entrada` : ''
  console.log(`  ${id.padEnd(34)} ${m.displayName ?? ''} ${entrada ? `· ${entrada}` : ''}`)
}

// El primero que parezca "flash" suele ser el barato; si no hay, el primero.
const sugerido = utiles.find((m) => /flash/i.test(m.name)) ?? utiles[0]
const id = sugerido.name.replace(/^models\//, '')

console.log('')
console.log('Para api.env, ajustando los centavos por millón a los precios de hoy:')
console.log('')
console.log(`  GEMINI_MODELS="${id}:${sugerido.displayName ?? id}:30:250"`)
console.log('')
console.log('El formato es  id:Etiqueta:centavosEntrada:centavosSalida  separado por comas.')
console.log('Esos centavos alimentan el contador y el tope de gasto: si mienten, el tope miente.')
