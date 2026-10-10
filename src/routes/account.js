'use strict';
// Account lifecycle: closed sign-ups ("Coming soon"), invitations, email verification, account settings, password reset.
// Mounted BEFORE the legacy routers so it can take over /register, /api/register, /sell, /account and /api/sell/onboard.
const express = require('express');
const config = require('../config');
const { q, tx, now } = require('../db');
const { esc, cleanLine, HttpError, date } = require('../util');
const V = require('../views');
const auth = require('../auth');
const tokens = require('../accountTokens');
const inv = require('../invitations');
const email = require('../email');
const { audit } = require('../audit');

const r = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const page = (req, res, o) => res.send(V.layout({ user: req.user, path: req.path, ...o }));
const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });   // pages whose URL carries a secret token
const ipKey = (req, k) => `${k}:${req.ip}`;

// ---------- Closed sign-ups: "Coming soon" ----------
const soon = () => V.comingSoon();
r.get('/register', (req, res, next) => {
  if (config.signups === 'open') return next();
  if (req.user) return res.redirect('/');
  page(req, res, { title: 'Coming soon', body: soon() });
});
r.post('/api/register', (req, res, next) => {
  if (config.signups === 'open') return next();
  res.status(403).json({ error: `Sign-ups are closed during the private beta. Selling available ${V.releaseText()}.` });
});
// Selling: invitation-only. (Open self-service onboarding exists only when SELLER_ONBOARDING=open, i.e. development/test.)
r.get('/sell', (req, res, next) => {
  if ((req.user && req.user.is_seller) || config.sellerOnboarding === 'open') return next();
  page(req, res, { title: 'Selling — coming soon', path: '/sell', body: soon() });
});
r.post('/api/sell/onboard', auth.requireUser, (req, res) => {
  if (config.sellerOnboarding !== 'open') throw new HttpError(403, 'Seller accounts are by invitation only during the private beta.');
  if (req.user.is_seller) throw new HttpError(409, 'You already have a store.');
  inv.onboardOpen(req.user, req.body);
  res.json({ ok: true });
});

// ---------- Invitations ----------
const storeFields = `<div class="row"><div><label for="sc">Ships from (country)</label><select id="sc" name="country">${config.naCountries.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></div>
  <div><label for="sr">State / province</label><input id="sr" name="region" required></div><div><label for="sy">City</label><input id="sy" name="city" required></div></div>`;
r.get('/invite/:token', (req, res) => {
  noStore(res);
  auth.rateLimit(ipKey(req, 'invite-view'), 60, 3600);
  const i = inv.lookup(req.params.token);
  if (!i) return page(req, res, { title: 'Invitation', body: V.empty('This invitation is invalid, expired or already used', 'Ask the PairPlug team for a new one.', ['/', 'Home']) });
  const existing = q.get('SELECT id FROM users WHERE email = ?', i.email);
  const seller = i.kind === 'seller';
  const needLogin = existing && !(req.user && req.user.id === existing.id);
  if (needLogin) return page(req, res, { title: 'Invitation', body: `<div class="narrow panel"><h1>You're invited</h1><p>This invitation is for an existing PairPlug account (<strong>${esc(i.email)}</strong>). Log in with that account, then open this link again.</p><a class="btn" href="/login?next=${encodeURIComponent('/invite/' + req.params.token)}">Log in</a></div>` });
  const body = `<div class="narrow panel form-wide" style="max-width:560px"><h1>${seller ? 'Open your PairPlug store' : 'Join PairPlug'}</h1>
    <p class="muted small">Invitation for <strong>${esc(i.email)}</strong> · expires ${date(i.expires_at)}. ${seller ? 'During the beta PairPlug has no fees: buyers pay you directly through your own Stripe checkout, and you are expected to reply to buyer messages within 48 hours.' : ''}</p>
    <form data-api="/api/invitations/accept" data-redirect="/account"><input type="hidden" name="token" value="${esc(req.params.token)}">
      ${existing ? '' : '<label for="n">Your name</label><input id="n" name="display_name" autocomplete="name" required><label for="p">Password <span class="opt">(8+ characters)</span></label><input id="p" name="password" type="password" autocomplete="new-password" minlength="8" required>'}
      ${seller ? `<label for="sn">Store name</label><input id="sn" name="store_name" maxlength="60" required><label for="sh">Store URL <span class="opt">(pairplug.com/s/…)</span></label><input id="sh" name="handle" pattern="[a-zA-Z0-9_-]{3,30}" required>${storeFields}
        <label for="sb">About <span class="opt">(optional)</span></label><textarea id="sb" name="bio" maxlength="500"></textarea>
        <label style="font-weight:400;display:flex;gap:8px;margin-top:12px"><input type="checkbox" name="agree" required> I only list items I own, will ship what I sell, and will reply to buyers within 48 hours.</label>` : ''}
      <button class="btn block" style="margin-top:14px" type="submit">${seller ? 'Create store' : 'Create account'}</button></form></div>`;
  page(req, res, { title: 'Invitation', body });
});
r.post('/api/invitations/accept', (req, res) => {
  noStore(res);
  auth.rateLimit(ipKey(req, 'invite-accept'), 20, 3600);
  const userId = inv.accept(String(req.body.token || ''), req.body, req.user);
  if (!req.user) auth.createSession(res, userId);
  const u = q.get('SELECT * FROM users WHERE id = ?', userId);
  tokens.sendVerification(u).catch(() => {});                 // best effort; the outbox records it either way
  res.json({ ok: true });
});

// ---------- Email verification ----------
const deliveryNote = () => (email.isConfigured() ? 'We sent you an email.' : 'Email delivery is not configured on this server yet, so no email could be sent. Contact the PairPlug team to finish verification.');
r.get('/verify-email', (req, res) => {
  noStore(res);
  const t = String(req.query.token || '');
  page(req, res, { title: 'Verify email', body: `<div class="narrow panel"><h1>Confirm your email</h1><p>Press the button to confirm this email address for your PairPlug account.</p>
    <button class="btn block" id="vbtn" data-post="/api/email/verify" data-body='${esc(JSON.stringify({ token: t }))}' data-redirect="/account">Confirm email</button></div>` });
});
r.post('/api/email/verify', (req, res) => {
  auth.rateLimit(ipKey(req, 'verify'), 30, 3600);
  tokens.confirmVerification(String(req.body.token || '')); res.json({ ok: true });
});
r.post('/api/email/resend', auth.requireUser, (req, res) => {
  if (req.user.email_verified_at) return res.json({ ok: true, message: 'Your email is already verified.' });
  tokens.sendVerification(req.user).catch(() => {});
  res.json({ ok: true, message: deliveryNote() });
});
r.get('/confirm-email-change', (req, res) => {
  noStore(res);
  page(req, res, { title: 'Confirm new email', body: `<div class="narrow panel"><h1>Confirm your new email</h1><button class="btn block" data-post="/api/email/confirm-change" data-body='${esc(JSON.stringify({ token: String(req.query.token || '') }))}' data-redirect="/account">Confirm new email</button></div>` });
});
r.post('/api/email/confirm-change', (req, res) => { auth.rateLimit(ipKey(req, 'verify'), 30, 3600); tokens.confirmEmailChange(String(req.body.token || '')); res.json({ ok: true }); });

// ---------- Account page ----------
r.get('/account', auth.requireUser, (req, res) => {
  const u = req.user, verified = Boolean(u.email_verified_at);
  const body = `<h1>Account</h1><div class="two"><section>
    <form class="panel" data-api="/api/account" data-method="PATCH"><h3>Profile</h3><label for="dn">Name</label><input id="dn" name="display_name" value="${esc(u.display_name)}" required><button class="btn" type="submit" style="margin-top:12px">Save</button></form>
    <div class="panel"><h3>Email</h3><p style="margin:0 0 8px">${esc(u.email)} ${verified ? '<span class="pill s-active">Verified</span>' : '<span class="pill s-pending_payment">Not verified</span>'}</p>
      ${verified ? '' : `<p class="small">${u.is_seller ? '<strong>Sellers must verify their email before publishing listings or receiving orders.</strong> ' : ''}<button class="btn small" data-post="/api/email/resend">Send verification email</button></p>${email.isConfigured() ? '' : '<p class="small muted">Email delivery is not configured on this server yet. The PairPlug team can complete verification with you.</p>'}`}
      <form data-api="/api/account/email" data-method="POST" style="margin-top:12px"><label for="ne">Change email</label><input id="ne" name="email" type="email" required><label for="cp">Current password</label><input id="cp" name="password" type="password" autocomplete="current-password" required><button class="btn ghost small" type="submit" style="margin-top:10px">Change email</button></form></div>
    <form class="panel" data-api="/api/account/password" data-method="POST"><h3>Password</h3><label for="p0">Current password</label><input id="p0" name="current" type="password" autocomplete="current-password" required>
      <label for="p1">New password <span class="opt">(8+ characters)</span></label><input id="p1" name="next" type="password" autocomplete="new-password" minlength="8" required><button class="btn" type="submit" style="margin-top:12px">Change password</button><p class="small muted">Changing your password signs you out everywhere else.</p></form></section>
    <aside class="panel">${u.is_seller ? `<p><a href="/dashboard">Seller dashboard →</a></p><p><a href="/dashboard/storefront">Customize storefront →</a></p><p><a href="/s/${esc(u.handle)}">View my storefront →</a></p>` : '<p class="muted small">PairPlug sellers are invited during the private beta.</p>'}<p><a href="/messages">Messages →</a></p><p><a href="/support">Contact PairPlug support →</a></p></aside></div>`;
  page(req, res, { title: 'Account', body });
});
r.post('/api/account/email', auth.requireUser, (req, res) => {
  auth.rateLimit(`acct-email:${req.user.id}`, 5, 3600);
  const addr = cleanLine(req.body.email, 200).toLowerCase();
  if (!auth.verifyPassword(String(req.body.password || ''), req.user.password_hash)) throw new HttpError(403, 'Your current password is incorrect.');
  if (!EMAIL_RE.test(addr)) throw new HttpError(422, 'Please fix the highlighted fields.', { email: 'Enter a valid email address.' });
  tokens.requestEmailChange(req.user, addr).catch(() => {});
  audit(req.user, 'email_change_requested', { type: 'user', id: req.user.id });
  res.json({ ok: true, message: email.isConfigured() ? 'Check your new inbox to confirm the change. Your current email stays active until you do.' : 'Email delivery is not configured on this server yet, so the confirmation could not be sent. Your email has not changed.' });
});
r.post('/api/account/password', auth.requireUser, (req, res) => {
  auth.rateLimit(`acct-pw:${req.user.id}`, 8, 3600);
  if (!auth.verifyPassword(String(req.body.current || ''), req.user.password_hash)) throw new HttpError(403, 'Your current password is incorrect.');
  const pw = String(req.body.next || '');
  if (pw.length < 8 || pw.length > 200) throw new HttpError(422, 'Please fix the highlighted fields.', { next: 'Use at least 8 characters.' });
  tx(() => { q.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(pw), req.user.id); auth.destroyOtherSessions(req, req.user.id); });
  audit(req.user, 'password_changed', { type: 'user', id: req.user.id });
  res.json({ ok: true, message: 'Password changed. Other devices were signed out.' });
});

// ---------- Password reset (only when real email delivery is configured; otherwise honestly unavailable) ----------
r.get('/forgot-password', (req, res) => {
  page(req, res, { title: 'Reset password', body: email.isConfigured()
    ? `<div class="narrow panel"><h1>Reset your password</h1><form data-api="/api/password/forgot" data-reload><label for="fe">Email</label><input id="fe" name="email" type="email" required><button class="btn block" style="margin-top:12px" type="submit">Send reset link</button></form></div>`
    : `<div class="narrow panel"><h1>Reset your password</h1><p>Automatic password reset isn't available yet because email delivery isn't set up. Please <a href="/support">contact PairPlug support</a> and we'll help you get back in.</p></div>` });
});
r.post('/api/password/forgot', (req, res) => {
  if (!email.isConfigured()) throw new HttpError(503, 'Password reset by email is not available yet. Contact PairPlug support.');
  auth.rateLimit(ipKey(req, 'forgot'), 10, 3600);
  const addr = cleanLine(req.body.email, 200).toLowerCase();
  if (addr) auth.rateLimit(`forgot-mail:${addr}`, 3, 3600);
  const u = EMAIL_RE.test(addr) ? q.get('SELECT * FROM users WHERE email = ? AND banned = 0', addr) : null;
  if (u) { try { tokens.sendPasswordReset(u).catch(() => {}); } catch (e) { if (e.status !== 429) throw e; } }
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });     // identical response whether or not the account exists
});
r.get('/reset-password', (req, res) => {
  noStore(res);
  page(req, res, { title: 'Choose a new password', body: `<div class="narrow panel"><h1>Choose a new password</h1><form data-api="/api/password/reset" data-redirect="/login"><input type="hidden" name="token" value="${esc(String(req.query.token || ''))}">
    <label for="np">New password <span class="opt">(8+ characters)</span></label><input id="np" name="password" type="password" minlength="8" autocomplete="new-password" required><button class="btn block" style="margin-top:12px" type="submit">Set password</button></form></div>` });
});
r.post('/api/password/reset', (req, res) => {
  if (!email.isConfigured()) throw new HttpError(503, 'Password reset by email is not available yet.');
  auth.rateLimit(ipKey(req, 'reset'), 20, 3600);
  const pw = String(req.body.password || '');
  if (pw.length < 8 || pw.length > 200) throw new HttpError(422, 'Please fix the highlighted fields.', { password: 'Use at least 8 characters.' });
  tx(() => {
    const t = tokens.consume(String(req.body.token || ''), 'reset_password');
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(pw), t.user_id);
    q.run('DELETE FROM sessions WHERE user_id = ?', t.user_id);                         // every existing session is invalidated
    q.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND lower(email) = lower(?)', now(), t.user_id, t.email);
    audit('system', 'password_reset', { type: 'user', id: t.user_id });
  });
  res.json({ ok: true });
});

module.exports = { router: r };
