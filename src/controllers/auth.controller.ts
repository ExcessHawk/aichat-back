import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Get,
  Inject,
  InjectDB,
  Post,
  Roles,
  UseMiddleware,
} from 'veloce-ts';
import type { DrizzleDB } from '../db/client';
import { ANY_ROLE, requireUser } from '../auth/current-user';
import { AuthService } from '../services/auth.service';
import {
  LoginSchema,
  RefreshSchema,
  RegisterSchema,
  type LoginDto,
  type RefreshDto,
  type RegisterDto,
} from '../dtos/chat.dto';
import { authRateLimit } from '../middleware/rate-limit.middleware';

@Controller('/api/auth')
export class AuthController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(AuthService) private auth: AuthService,
  ) {}

  @Post('/register')
  @UseMiddleware(authRateLimit)
  async register(@Body(RegisterSchema) body: RegisterDto, @Ctx() c: Context) {
    const sesion = await this.auth.register(this.db, body);
    c.status(201);
    return sesion;
  }

  @Post('/login')
  @UseMiddleware(authRateLimit)
  async login(@Body(LoginSchema) body: LoginDto) {
    return this.auth.login(this.db, body);
  }

  @Post('/refresh')
  @UseMiddleware(authRateLimit)
  async refresh(@Body(RefreshSchema) body: RefreshDto) {
    return this.auth.refresh(this.db, body.refreshToken);
  }

  @Get('/me')
  @Roles(ANY_ROLE)
  async me(@Ctx() c: Context) {
    return { user: requireUser(c) };
  }

  @Post('/logout')
  @Roles(ANY_ROLE)
  async logout(@Ctx() c: Context) {
    const user = requireUser(c);
    const expira = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.auth.logout(this.db, user.jti, expira);
    return { message: 'Sesión cerrada' };
  }
}
