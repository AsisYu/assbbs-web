import type { Config } from 'drizzle-kit';

export default {
  schema: './app/data.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'file:./app.db'
  }
} satisfies Config;
