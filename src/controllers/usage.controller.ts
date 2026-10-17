import type { Context } from 'hono';
import { Controller, Ctx, Get, Inject, InjectDB, Roles } from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { ANY_ROLE, requireUser } from '../auth/current-user';
import { UsageService } from '../services/usage.service';
import { ChatService } from '../services/chat.service';

@Controller('/api')
export class UsageController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(UsageService) private usage: UsageService,
    @Inject(ChatService) private chat: ChatService,
  ) {}

  /** Lo gastado en el periodo, y contra qué tope. */
  @Get('/usage')
  @Roles(ANY_ROLE)
  async usageNow(@Ctx() c: Context) {
    const user = requireUser(c);
    return this.usage.actual(this.db, user.id);
  }

  /**
   * Qué modelos hay y a qué precio.
   *
   * Es público a propósito: la pantalla de entrada dice con qué se está
   * hablando antes de pedirle a nadie que cree una cuenta.
   */
  @Get('/models')
  async models() {
    return { models: this.chat.modelosDisponibles() };
  }
}
