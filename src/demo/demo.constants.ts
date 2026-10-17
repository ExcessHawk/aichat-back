/**
 * La demostración entrega sesiones sin contraseña.
 *
 * Es un bypass de autenticación puesto a propósito, así que lleva cuatro
 * candados que tienen que estar de acuerdo: la bandera `DEMO_MODE`, el dominio
 * del correo, la columna `is_demo`, y la comprobación del servicio antes de
 * firmar nada.
 *
 * Aquí hay un candado más que en los otros proyectos: el proveedor del modelo.
 * Una demo abierta contra un modelo que se cobra por token es una factura
 * esperando a que alguien la encuentre, así que la demostración corre con el
 * proveedor falso.
 */

export const DEMO_DOMAIN = '@demo.chat.mx';

export const DEMO_ROLES = ['usuario', 'administrador'] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

export const DEMO_ACCOUNTS: Record<DemoRole, string> = {
  usuario: `usuario${DEMO_DOMAIN}`,
  administrador: `admin${DEMO_DOMAIN}`,
};

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'true';
}
