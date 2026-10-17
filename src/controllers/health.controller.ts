import { Controller, Get } from 'veloce-ts';

@Controller('/health')
export class HealthController {
  @Get('/')
  check() {
    return { status: 'OK', timestamp: new Date().toISOString() };
  }

  /** Lo que mira el healthcheck del contenedor. */
  @Get('/ready')
  ready() {
    return { status: 'ready' };
  }
}
