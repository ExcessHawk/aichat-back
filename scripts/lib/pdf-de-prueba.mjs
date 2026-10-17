/**
 * PDF mínimo, válido y con texto extraíble.
 *
 * Las pruebas necesitan un PDF de verdad —uno que un extractor pueda abrir— y
 * no un archivo que empiece con %PDF. Esto arma el más chico que cumple: un
 * catálogo, una página, una fuente estándar y un flujo de contenido con Tj.
 */
const ESCAPAR = /[()\\]/g

export function pdfConTexto(lineas) {
  const contenido =
    'BT /F1 12 Tf 72 720 Td 14 TL\n' +
    lineas.map((l) => `(${l.replace(ESCAPAR, (c) => '\\' + c)}) Tj T*`).join('\n') +
    '\nET'

  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objetos.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })

  const inicioXref = pdf.length
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objetos.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`

  return new TextEncoder().encode(pdf)
}
