import { Router } from 'express';
import ExcelJS from 'exceljs';
import { one, many, query } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { perm, permAny, requireStaff } from '../middleware/auth.js';
import { REPORTS, dashboard, ownerDashboard } from '../services/reports.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(requireStaff);

r.get('/dashboard', perm('dashboard.view'), async (req, res) => {
  const data = await dashboard(req.query);
  if (!req.ctx.staff.permissions.has('dashboard.revenue')) {
    for (const k of ['revenue', 'cashIn', 'refunds', 'topup', 'topupBonus', 'arcadeRevenue', 'foodRevenue', 'averageSpend', 'walletLiability']) data.kpi[k] = null;
    data.charts.byHour = []; data.charts.methods = [];
    data.charts.byDay = data.charts.byDay.map((x) => ({ day: x.day, plays: x.plays }));
  }
  res.json(data);
});
r.get('/dashboard/owner', perm('dashboard.owner'), async (req, res) => res.json(await ownerDashboard(req.query)));

r.get('/reports', perm('report.view'), (_req, res) => res.json({ items: Object.entries(REPORTS).map(([key, v]) => ({ key, label: v.label })) }));

r.get('/reports/:key', perm('report.view'), async (req, res) => {
  const rep = REPORTS[req.params.key];
  if (!rep) throw fail('NOT_FOUND', 'Unknown report');
  const out = await rep.run(req.query);
  const fmt = req.query.format;
  if (!fmt || fmt === 'json') {
    const page = Math.max(1, Number(req.query.page) || 1); const size = Math.min(500, Number(req.query.pageSize) || 100);
    return res.json({ key: req.params.key, label: rep.label, columns: out.columns.map(([key, label, type]) => ({ key, label, type: type || 'text' })), rows: out.rows.slice((page - 1) * size, page * size), total: out.rows.length, page, pageSize: size, summary: out.summary });
  }
  if (!req.ctx.staff.permissions.has('report.export')) throw fail('FORBIDDEN', 'Export not permitted', { permission: 'report.export' });
  await audit(null, req.ctx, { action: 'REPORT_EXPORT', targetType: 'report', targetId: req.params.key, newData: { format: fmt, filters: req.query, rows: out.rows.length } });
  const filename = `${req.params.key}-${new Date().toISOString().slice(0, 10)}`;
  if (fmt === 'csv') {
    const esc = (v) => { if (v == null) return ''; const s = v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [out.columns.map((c) => esc(c[1])).join(','), ...out.rows.map((row) => out.columns.map((c) => esc(row[c[0]])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send('﻿' + lines.join('\n'));
  }
  if (fmt === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(rep.label.slice(0, 30));
    ws.columns = out.columns.map(([key, header, type]) => ({ key, header, width: Math.max(12, header.length + 4), style: type === 'money' ? { numFmt: '#,##0.00' } : type === 'datetime' ? { numFmt: 'yyyy-mm-dd hh:mm' } : {} }));
    ws.getRow(1).font = { bold: true };
    for (const row of out.rows) ws.addRow(Object.fromEntries(out.columns.map(([k, , t]) => [k, t === 'money' && row[k] != null ? Number(row[k]) : row[k]])));
    const sws = wb.addWorksheet('Summary');
    sws.addRow(['Report', rep.label]); sws.addRow(['Filters', JSON.stringify({ ...req.query, format: undefined })]); sws.addRow(['Generated', new Date().toISOString()]);
    for (const [k, v] of Object.entries(out.summary || {})) sws.addRow([k, v]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  throw fail('VALIDATION_ERROR', 'format must be json, csv or xlsx (PDF: use Print → Save as PDF)');
});

/** Global search across members, cards, transactions, receipts, rewards, machines. */
r.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q}%`; const digits = q.replace(/[\s-]/g, '');
  const P = req.ctx.staff.permissions;
  const tasks = [];
  if (P.has('member.view')) tasks.push(many({ query }, `SELECT 'member' AS kind, id, member_code AS title, first_name || ' ' || last_name || ' · ' || phone AS subtitle FROM members WHERE status NOT IN ('MERGED','DELETED') AND (member_code ILIKE $1 OR phone LIKE $2 OR (first_name || ' ' || last_name) ILIKE $1 OR nickname ILIKE $1) LIMIT 6`, [like, `%${digits}%`]));
  if (P.has('card.view')) tasks.push(many({ query }, `SELECT 'card' AS kind, id, card_number AS title, card_type || ' · ' || status || ' · ฿' || balance AS subtitle FROM cards WHERE card_number LIKE $1 OR rfid_uid = upper($2) LIMIT 6`, [`%${digits}%`, q]));
  if (P.has('transaction.view')) {
    tasks.push(many({ query }, `SELECT 'transaction' AS kind, id, txn_no AS title, type || ' · ' || (amount + bonus) AS subtitle FROM transactions WHERE txn_no ILIKE $1 LIMIT 5`, [like]));
    tasks.push(many({ query }, `SELECT 'receipt' AS kind, id, receipt_no AS title, type || ' · ' || coalesce(data->>'orderNo','') AS subtitle FROM receipts WHERE receipt_no ILIKE $1 LIMIT 5`, [like]));
    tasks.push(many({ query }, `SELECT 'order' AS kind, id, order_no AS title, status || ' · ฿' || grand_total AS subtitle FROM orders WHERE order_no ILIKE $1 LIMIT 5`, [like]));
  }
  if (P.has('reward.view')) tasks.push(many({ query }, `SELECT 'reward' AS kind, id, name AS title, points_required || ' pts / ' || stamps_required || ' stamps' AS subtitle FROM rewards WHERE name ILIKE $1 OR sku ILIKE $1 LIMIT 5`, [like]));
  if (P.has('machine.view')) tasks.push(many({ query }, `SELECT 'machine' AS kind, id, name AS title, machine_code || ' · ' || status AS subtitle FROM machines WHERE name ILIKE $1 OR machine_code ILIKE $1 LIMIT 5`, [like]));
  if (P.has('reward.redeem')) tasks.push(many({ query }, `SELECT 'redemption' AS kind, id, code AS title, status AS subtitle FROM redemptions WHERE code = upper($1) LIMIT 2`, [q]));
  res.json({ results: (await Promise.all(tasks)).flat() });
});

export default r;
