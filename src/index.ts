/**
 * Arranque: plugins, DI y compile. El único archivo de cableado.
 *
 * El orden de registro importa y es el de 00-base/PLANTILLA.md:
 * OpenAPI → Auth → RBAC → límite global → controladores → servicios → compile.
 */
import 'reflect-metadata';
import {
  AuthPlugin,
  JWTProvider,
  OpenAPIPlugin,
  RBACPlugin,
  Veloce,
  registerDrizzle,
} from 'veloce-ts';
import { eq, lt } from 'drizzle-orm';
import { db, pool } from './db/client';
import { revokedTokens } from './db/schema';
import { customUserProvider } from './auth/user-provider';
import { AuthService } from './services/auth.service';
import { ChatService } from './services/chat.service';
import { UsageService } from './services/usage.service';
import { createModelProvider } from './services/model.provider';
import { AuthController } from './controllers/auth.controller';
import { ConversationsController } from './controllers/conversations.controller';
import { UsageController } from './controllers/usage.controller';
import { HealthController } from './controllers/health.controller';
import { DemoController } from './controllers/demo.controller';
import { demoModeEnabled } from './demo/demo.constants';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const PORT = Number(process.env.PORT ?? 3107);

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('Faltan JWT_SECRET y JWT_REFRESH_SECRET. Copia .env.example a .env.');
}

const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean)) ?? [
    'http://localhost:5107',
  ],
);

function isAllowedOrigin(origin: string): boolean {
  if (CORS_ORIGINS.has(origin)) return true;
  if (process.env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    return true;
  }
  return false;
}

const app = new Veloce({
  title: 'Chat con IA API',
  version: '0.1.0',
  description: 'Chat con streaming de tokens sobre Veloce-TS',
  cors: {
    origin: isAllowedOrigin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});

app.usePlugin(new OpenAPIPlugin({ path: '/openapi.json', docsPath: '/docs' }));

const authPlugin = new AuthPlugin({
  jwt: {
    secret: JWT_SECRET,
    expiresIn: process.env.JWT_ACCESS_EXPIRES ?? '1h',
    refreshSecret: JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES ?? '30d',
  },
  userProvider: customUserProvider,
  enableDefaultRoutes: false,
});
app.usePlugin(authPlugin);

app.usePlugin(
  new RBACPlugin({
    roles: [
      { name: 'user', permissions: ['conversations:own'], level: 10 },
      { name: 'admin', permissions: ['*'], inherits: ['user'], level: 100 },
    ],
  }),
);

app.useRateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_MAX ?? 300) });

const hono = app.getHono();

hono.use(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
});

/**
 * El logout tiene que cortar de inmediato.
 *
 * Sin esto, un token robado seguiría valiendo hasta expirar aunque la persona
 * haya cerrado sesión.
 */
const jwtProvider = authPlugin.getAuthService().getJWTProvider();
hono.use(async (c, next) => {
  const cabecera = c.req.header('authorization');
  if (cabecera?.startsWith('Bearer ')) {
    try {
      const payload = jwtProvider.verifyAccessToken(cabecera.slice(7)) as { jti?: string };
      if (payload?.jti) {
        const [revocado] = await db
          .select({ jti: revokedTokens.jti })
          .from(revokedTokens)
          .where(eq(revokedTokens.jti, payload.jti));
        if (revocado) {
          return c.json({ error: 'La sesión fue cerrada', statusCode: 401 }, 401);
        }
      }
    } catch {
      /* token inválido: que lo rechace el plugin de auth, no este middleware */
    }
  }
  await next();
});

registerDrizzle(app, db);

const container = app.getContainer();
container.register(JWTProvider, { factory: () => jwtProvider, scope: 'singleton' });

const authService = new AuthService(jwtProvider);
container.register(AuthService, { factory: () => authService, scope: 'singleton' });

const usageService = new UsageService();
container.register(UsageService, { factory: () => usageService, scope: 'singleton' });

const modelProvider = createModelProvider();
container.register('ModelProvider', { factory: () => modelProvider, scope: 'singleton' });
container.register(ChatService, {
  factory: () => new ChatService(modelProvider, usageService),
  scope: 'singleton',
});

app.include(HealthController);
app.include(AuthController);
app.include(ConversationsController);
app.include(UsageController);

// Sin la bandera estas rutas no se registran, así que responden 404 y no 403:
// un 403 confirmaría que hay algo aquí.
if (demoModeEnabled()) {
  app.include(DemoController);
  if (modelProvider.name !== 'echo') {
    console.warn(
      'DEMO_MODE encendido con un proveedor de modelo real. Cada visitante gasta dinero.',
    );
  }
  console.warn('DEMO_MODE encendido: /api/demo/session entrega sesiones sin contraseña');
}

async function start() {
  await app.compile();

  // Los tokens revocados que ya expiraron no protegen nada y la tabla crece.
  setInterval(() => {
    db.delete(revokedTokens).where(lt(revokedTokens.expiresAt, new Date())).catch(() => {});
  }, 60 * 60_000).unref?.();

  app.listen(PORT, () => {
    console.log(`API del chat en http://localhost:${PORT}`);
    console.log(`Documentación en http://localhost:${PORT}/docs`);
    console.log(`Modelo: ${modelProvider.name}`);
  });

  app.setShutdownTimeout(10_000);
  app.onShutdown(async () => {
    await pool.end();
  });
}

start().catch((error) => {
  console.error('No arrancó:', error);
  process.exit(1);
});
