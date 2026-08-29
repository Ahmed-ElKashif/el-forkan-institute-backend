import { defineConfig } from 'prisma/config';
import { config as loadEnv } from 'dotenv';

loadEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
