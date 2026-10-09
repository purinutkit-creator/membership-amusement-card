import 'dotenv/config';

const env = process.env.NODE_ENV || 'development';

export const config = {
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: Number(process.env.PORT || 4000),
  databaseUrl:
    process.env.DATABASE_URL ||
    (env === 'test'
      ? 'postgres://arcade:arcade@localhost:5432/arcade_test'
      : 'postgres://arcade:arcade@localhost:5432/arcade_dev'),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`,
  uploadDir: process.env.UPLOAD_DIR || new URL('../uploads/', import.meta.url).pathname,
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : env === 'production',
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
  owner: {
    username: process.env.OWNER_USERNAME,
    password: process.env.OWNER_PASSWORD,
    employeeCode: process.env.OWNER_EMPLOYEE_CODE || 'OWNER',
    pin: process.env.OWNER_PIN,
    firstName: process.env.OWNER_FIRST_NAME || 'Owner',
    email: process.env.OWNER_EMAIL,
  },
  setupToken: process.env.SETUP_TOKEN,
  payment: {
    gateway: process.env.PAYMENT_GATEWAY || (env === 'production' ? 'none' : 'mock'),
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || (env === 'production' ? '' : 'dev-webhook-secret'),
  },
  otp: { provider: process.env.OTP_PROVIDER || (env === 'production' ? 'none' : 'console') },
  ai: {
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.AI_MODEL || 'claude-opus-5-5',
  },
  machineController: process.env.MACHINE_CONTROLLER || 'socket',
};

if (config.isProd && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production (use your Postgres internal connection string)');
}
