import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { attachContext, csrfGuard } from './middleware/auth.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 'loopback');
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'connect-src': ["'self'", 'ws:', 'wss:', 'http://localhost:9110', 'http://127.0.0.1:9110'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(cookieParser());
  if (config.corsOrigins.length) {
    app.use((req, res, next) => {
      const o = req.headers.origin;
      if (o && config.corsOrigins.includes(o)) {
        res.setHeader('Access-Control-Allow-Origin', o);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Branch-Id, X-Device-Token');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
      }
      next();
    });
  }
  fs.mkdirSync(config.uploadDir, { recursive: true });
  // Uploaded files are untrusted: sandbox them so an SVG/HTML opened directly cannot run script.
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; font-src 'self' data:");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  } }));
  app.use('/api', attachContext, csrfGuard, apiRouter);
  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', 'API route not found', 404)));

  // Serve built frontend (SPA) in production
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|uploads|socket\.io).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
    if (err.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Duplicate value: ' + (err.detail || '').replace(/^Key /, '') } });
    if (err.code === '23514' || err.code === '23503') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Operation violates data integrity rules' } });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: { code: 'ERROR', message: err.message } });
    logger.error('http.unhandled', { message: err.message, stack: err.stack, path: req.path });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  });
  return app;
}
