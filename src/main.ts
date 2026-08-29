import 'dotenv/config'; // must run before anything reads process.env, including module construction
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN,
      credentials: true, // the frontend sends the refresh cookie cross-origin
    }),
  );
  app.use(hpp());
  app.use(cookieParser());
  app.useGlobalPipes(new ZodValidationPipe());

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
