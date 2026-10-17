import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Get,
  Inject,
  InjectDB,
  Post,
  ServiceUnavailableException,
  UseMiddleware,
} from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { users } from '../db/schema';
import { AuthService } from '../services/auth.service';
import { DEMO_ACCOUNTS, DEMO_DOMAIN, DEMO_ROLES, demoModeEnabled } from '../demo/demo.constants';
import { DemoSessionSchema, type DemoSessionDto } from '../dtos/chat.dto';
import { demoRateLimit } from '../middleware/rate-limit.middleware';

@Controller('/api/demo')
export class DemoController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(AuthService) private auth: AuthService,
  ) {}

  @Get('/roles')
  roles() {
    return { roles: DEMO_ROLES.map((role) => ({ role, email: DEMO_ACCOUNTS[role] })) };
  }

  @Post('/session')
  @UseMiddleware(demoRateLimit)
  async session(@Body(DemoSessionSchema) body: DemoSessionDto, @Ctx() c: Context) {
    // Segundo candado: aunque el controlador esté registrado, sin la bandera
    // no firma nada.
    if (!demoModeEnabled()) {
      throw new ServiceUnavailableException('La demostración no está encendida');
    }

    const email = DEMO_ACCOUNTS[body.role];
    // Tercero y cuarto: el correo tiene que ser del dominio de demostración y
    // la fila tiene que estar marcada.
    if (!email.endsWith(DEMO_DOMAIN)) {
      throw new ServiceUnavailableException('Rol de demostración desconocido');
    }

    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), eq(users.isDemo, true)));
    if (!user) {
      throw new ServiceUnavailableException('La demostración todavía no está sembrada');
    }

    const sesion = await this.auth.issueForUser(this.db, user.id);
    c.header('Cache-Control', 'no-store');
    return sesion;
  }
}
