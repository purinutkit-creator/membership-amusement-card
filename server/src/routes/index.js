import { Router } from 'express';
import auth from './auth.js';
import admin from './admin.js';
import core from './core.js';
import pos from './pos.js';
import catalog from './catalog.js';
import devices from './devices.js';
import reports from './reports.js';
import member from './member.js';
import pub from './public.js';
import ai from './ai.js';

export const apiRouter = Router();
apiRouter.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
apiRouter.use('/auth', auth);
apiRouter.use('/public', pub);
apiRouter.use('/member', member);
apiRouter.use('/', devices); // device-facing + device/printer/media/playlist/pairing management (each route guards itself)
apiRouter.use('/', reports);
apiRouter.use('/', core);
apiRouter.use('/', pos);
apiRouter.use('/', catalog);
apiRouter.use('/', ai);
apiRouter.use('/', admin);
