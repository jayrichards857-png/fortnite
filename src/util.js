'use strict';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Strip control chars, collapse whitespace, cap length. Output is also HTML-escaped at render time.
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const cleanLine = (s, max = 200) => clean(s, max).replace(/\s+/g, ' ');
const dollarsToCents = (v) => {
  if (v === '' || v == null) return null;
  const s = String(v).trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
};
class HttpError extends Error { constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; } }
const date = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '—');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { wrap, esc, money, clean, cleanLine, dollarsToCents, HttpError, date };
