import 'dotenv/config'; // must run before anything reads process.env, including module construction
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';
import { corsAllowlist, getEnv, validateEnv } from './config/env';

async function bootstrap() {
  // §1.3: fail fast on misconfiguration, before Nest constructs any provider
  // that reads a secret. A missing JWT_ACCESS_SECRET aborts here, not on the
  // first login.
  validateEnv();
  const env = getEnv();

  const app = await NestFactory.create(AppModule);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Cheap hardening for a pure JSON API (F11e): forbid framing and
          // stop a `<base>` tag from rewriting relative URLs.
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        },
      },
    }),
  );

  // F6: fail closed. An unset CORS_ORIGIN yields an empty allowlist, which
  // rejects every cross-origin request instead of the `cors` package's default
  // of reflecting `*`. The allowlist is comma-separated so staging and
  // production can both be named.
  const allowlist = corsAllowlist();
  app.use(
    cors({
      origin(origin, callback) {
        // A same-origin or non-browser request (curl, server-to-server) sends
        // no Origin header; those are not the CORS threat and are allowed.
        if (!origin || allowlist.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true, // the frontend sends the refresh cookie cross-origin
    }),
  );
  app.use(hpp());
  app.use(cookieParser());
  app.useGlobalPipes(new ZodValidationPipe());

  await app.listen(env.PORT);
}
void bootstrap();
