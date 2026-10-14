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
const LEGAL = require('../legal');
const email = require('../email');
const { audit } = require('../audit');

const r = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const page = async (req, res, o) => res.send(await V.layout({ user: req.user, path: req.path, ...o }));
const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });   // pages whose URL carries a secret token
const ipKey = (req, k) => `${k}:${req.ip}`;

// ---------- Closed sign-ups: "Coming soon" ----------
const soon = (kind) => V.comingSoon(kind);
r.get('/register', async (req, res, next) => {
  if (config.signups === 'open') return next();
  if (req.user) return res.redirect('/');
  await page(req, res, { title: 'Coming soon', body: soon('signup') });
});
r.post('/api/register', (req, res, next) => {
  if (config.signups === 'open') return next();
  res.status(403).json({ error: 'Sign-ups are paused during the private beta.' });
});
// Selling: any signed-in account starts selling immediately (account required; no approval, invitation, waitlist or limit). See src/sellerApplications.js.
const SA = require('../sellerApplications');
const { FREE_LISTING } = require('../pricing');
r.get('/sell', async (req, res, next) => {
  if (req.user && req.user.is_seller) return res.redirect('/dashboard');
  const intro = `<h1>Sell on PairPlug</h1><p class="lead">${esc(FREE_LISTING)}</p>
    <p class="small muted">Any PairPlug account can start selling right away. There is no fee, no approval and no limit on the number of sellers.</p>`;
  if (!req.user && config.signups !== 'open') return await page(req, res, { title: 'Selling — Coming Soon', path: '/sell', body: soon('sell') });   // accounts cannot be created yet (pre-release): the old Coming Soon page
  if (!req.user) return await page(req, res, { title: 'Sell on PairPlug', path: '/sell', body: `<div class="narrow panel" style="max-width:560px">${intro}
    <p>You need an account first: create a free account (or log in), then come back here to open your store. No fees, no subscription, no payment.</p>
    <p><a class="btn" href="/register?next=/sell">Create an account</a> <a class="btn ghost" href="/login?next=/sell">Log in</a></p></div>` });
  let body;
  body = `<div class="narrow panel form-wide" style="max-width:560px">${intro}
    <form data-api="/api/sell/apply" data-redirect="/dashboard"><label for="sn">Store name</label><input id="sn" name="store_name" maxlength="60" required><label for="sh">Store URL name <span class="opt">(3–30 letters, numbers, - _)</span></label><input id="sh" name="handle" maxlength="30" required>
    ${storeFields}<label for="sb">About your store <span class="opt">(optional)</span></label><textarea id="sb" name="bio" maxlength="500"></textarea>
    <label style="font-weight:400;display:flex;gap:8px;margin-top:10px"><input type="checkbox" name="agree"> <span>I agree to the <a href="/terms">Terms</a> and <a href="/rules">Seller rules</a>, and that I handle payments, shipping and refunds through my own Stripe Payment Link.</span></label>
    <button class="btn" type="submit" style="margin-top:12px">Start selling</button></form></div>`;
  await page(req, res, { title: 'Sell on PairPlug', path: '/sell', body });
});
r.post('/api/sell/apply', auth.requireUser, async (req, res) => res.json({ ok: true, ...(await SA.apply(req.user, req.body || {})) }));   // alias kept for older pages
r.post('/api/sell/apply/withdraw', auth.requireUser, async (req, res) => { await SA.withdraw(req.user); res.json({ ok: true }); });
r.post('/api/sell/onboard', auth.requireUser, async (req, res) => res.json({ ok: true, ...(await SA.apply(req.user, req.body || {})) }));   // same immediate path

// ---------- Invitations ----------
const storeFields = `<div class="row"><div><label for="sc">Ships from (country)</label><select id="sc" name="country">${config.naCountries.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></div>
  <div><label for="sr">State / province</label><input id="sr" name="region" required></div><div><label for="sy">City</label><input id="sy" name="city" required></div></div>`;
r.get('/invite/:token', async (req, res) => {
  noStore(res);
  await auth.rateLimit(ipKey(req, 'invite-view'), 60, 3600);
  const i = await inv.lookup(req.params.token);
  if (!i) return await page(req, res, { title: 'Invitation', body: V.empty('This invitation is invalid, expired or already used', 'Ask the PairPlug team for a new one.', ['/', 'Home']) });
  const existing = await q.get('SELECT id FROM users WHERE email = ?', i.email);
  const seller = i.kind === 'seller';
  const termsBox = !existing || !LEGAL.accepted(await q.get('SELECT terms_version, terms_accepted_at FROM users WHERE id = ?', existing.id)) ? `<label style="font-weight:400;display:flex;gap:8px;margin-top:12px"><input type="checkbox" name="terms" required> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and have read the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="/payments" target="_blank" rel="noopener">how payments and refunds work</a>.</span></label>` : '';
  const needLogin = existing && !(req.user && req.user.id === existing.id);
  if (needLogin) return await page(req, res, { title: 'Invitation', body: `<div class="narrow panel"><h1>You're invited</h1><p>This invitation is for an existing PairPlug account (<strong>${esc(i.email)}</strong>). Log in with that account, then open this link again.</p><a class="btn" href="/login?next=${encodeURIComponent('/invite/' + req.params.token)}">Log in</a></div>` });
  const body = `<div class="narrow panel form-wide" style="max-width:560px"><h1>${seller ? 'Open your PairPlug store' : 'Join PairPlug'}</h1>
    <p class="muted small">Invitation for <strong>${esc(i.email)}</strong> · expires ${date(i.expires_at)}. ${seller ? 'Listing on PairPlug is free and PairPlug takes 0% commission: buyers pay you directly through your own Stripe checkout (Stripe charges its own processing fees), and you are expected to reply to buyer messages within 48 hours.' : ''}</p>
    <form data-api="/api/invitations/accept" data-redirect="/account"><input type="hidden" name="token" value="${esc(req.params.token)}">
      ${existing ? '' : `<label for="n">Your name</label><input id="n" name="display_name" autocomplete="name" value="${esc(i.suggested_name || '')}" required><label for="p">Password <span class="opt">(8+ characters)</span></label><input id="p" name="password" type="password" autocomplete="new-password" minlength="8" required>`}
      ${seller ? `<label for="sn">Store name</label><input id="sn" name="store_name" maxlength="60" required><label for="sh">Store URL <span class="opt">(pairplug.com/s/…)</span></label><input id="sh" name="handle" pattern="[a-zA-Z0-9_-]{3,30}" required>${storeFields}
        <label for="sb">About <span class="opt">(optional)</span></label><textarea id="sb" name="bio" maxlength="500"></textarea>
        <label style="font-weight:400;display:flex;gap:8px;margin-top:12px"><input type="checkbox" name="agree" required> <span>I only list items I own, will ship what I sell, and will reply to buyers within 48 hours, and I have read the <a href="/rules" target="_blank" rel="noopener">Prohibited Items &amp; Seller Rules</a>.</span></label>` : ''}
      ${termsBox}
      <p class="small muted">Questions about this invitation? <a href="/contact">Contact us</a> or email ${V.contactLink()}.</p>
      <button class="btn block" style="margin-top:14px" type="submit">${seller ? 'Create store' : 'Create account'}</button></form></div>`;
  await page(req, res, { title: 'Invitation', body });
});
r.post('/api/invitations/accept', async (req, res) => {
  noStore(res);
  await auth.rateLimit(ipKey(req, 'invite-accept'), 20, 3600);
  const userId = await inv.accept(String(req.body.token || ''), req.body, req.user);
  if (!req.user) await auth.createSession(res, userId);
  const u = await q.get('SELECT * FROM users WHERE id = ?', userId);
  await tokens.sendVerification(u);                 // best effort; the outbox records it either way
  res.json({ ok: true });
});

// ---------- Email verification ----------
const devPreview = !config.isProd && !email.isConfigured();      // local development only: there is no switch that enables this in production
const deliveryNote = () => (email.isConfigured() ? 'We sent you an email.' : devPreview ? 'Development mode: no email was sent. Open the recorded message at /dev/emails and use its link.' : 'Email delivery is not configured on this server yet, so no email could be sent. Contact the PairPlug team to finish verification.');
r.get('/verify-email', async (req, res) => {
  noStore(res);
  const t = String(req.query.token || '');
  await page(req, res, { title: 'Verify email', body: `<div class="narrow panel"><h1>Confirm your email</h1><p>Press the button to confirm this email address for your PairPlug account.</p>
    <button class="btn block" id="vbtn" data-post="/api/email/verify" data-body='${esc(JSON.stringify({ token: t }))}' data-redirect="/account">Confirm email</button></div>` });
});
r.post('/api/email/verify', async (req, res) => {
  await auth.rateLimit(ipKey(req, 'verify'), 30, 3600);
  await tokens.confirmVerification(String(req.body.token || '')); res.json({ ok: true });
});
r.post('/api/email/resend', auth.requireUser, async (req, res) => {
  if (req.user.email_verified_at) return res.json({ ok: true, message: 'Your email is already verified.' });
  await tokens.sendVerification(req.user);
  res.json({ ok: true, message: deliveryNote() });
});
r.get('/confirm-email-change', async (req, res) => {
  noStore(res);
  await page(req, res, { title: 'Confirm new email', body: `<div class="narrow panel"><h1>Confirm your new email</h1><button class="btn block" data-post="/api/email/confirm-change" data-body='${esc(JSON.stringify({ token: String(req.query.token || '') }))}' data-redirect="/account">Confirm new email</button></div>` });
});
r.post('/api/email/confirm-change', async (req, res) => { await auth.rateLimit(ipKey(req, 'verify'), 30, 3600); await tokens.confirmEmailChange(String(req.body.token || '')); res.json({ ok: true }); });

// ---------- Local development only: read the emails that were RECORDED instead of sent ----------
// Not a verification bypass: the link inside still has to be opened and confirmed, exactly like a real email. Falls through to 404 in production
// and whenever a real email provider is configured. A user sees only messages addressed to their own email; admins see all.
r.get('/dev/emails', auth.requireUser, async (req, res, next) => {
  if (config.isProd || email.isConfigured()) return next();
  noStore(res);
  const rows = req.user.is_admin ? await q.all('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 30') : await q.all('SELECT * FROM email_outbox WHERE lower(to_email) = lower(?) ORDER BY id DESC LIMIT 30', req.user.email);
  const linkify = (t) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  await page(req, res, { title: 'Development emails', body: `<h1>Development email preview</h1><div class="panel notice small"><strong>Local development only.</strong> No email provider is configured, so messages are recorded here instead of being sent. This page does not exist in production.</div>
    ${rows.length ? rows.map((m) => `<div class="panel"><div class="muted small">${esc(new Date(m.created_at * 1000).toISOString().slice(0, 16).replace('T', ' '))} · to ${esc(m.to_email)} · ${esc(m.kind)}</div><h3>${esc(m.subject)}</h3><pre style="white-space:pre-wrap;margin:0;font:inherit">${linkify(m.body)}</pre></div>`).join('') : V.empty('No recorded emails', 'Use “Send verification email” on your Account page, then come back here.', ['/account', 'Account'])}` });
});

// ---------- Account page ----------
r.get('/account', auth.requireUser, async (req, res) => {
  const u = req.user, verified = Boolean(u.email_verified_at);
  const forced = u.must_change_password ? '<div class="form-err" role="alert"><strong>Your password is temporary.</strong> Choose a new one below before doing anything else.</div>' : '';
  const body = `<h1>Account</h1>${forced}<div class="two"><section>
    <form class="panel" data-api="/api/account" data-method="PATCH"><h3>Profile</h3><label for="dn">Name</label><input id="dn" name="display_name" value="${esc(u.display_name)}" required><button class="btn" type="submit" style="margin-top:12px">Save</button></form>
    <div class="panel"><h3>Email</h3><p style="margin:0 0 8px">${esc(u.email)} ${verified ? '<span class="pill s-active">Verified</span>' : ''}</p>
      ${verified || !email.isConfigured() ? '' : `<p class="small muted">Email confirmation is optional. <button class="btn small" data-post="/api/email/resend">Send verification email</button></p>`}
      <form data-api="/api/account/email" data-method="POST" style="margin-top:12px"><label for="ne">Change email</label><input id="ne" name="email" type="email" required><label for="cp">Current password</label><input id="cp" name="password" type="password" autocomplete="current-password" required><button class="btn ghost small" type="submit" style="margin-top:10px">Change email</button></form></div>
    <form class="panel" data-api="/api/account/password" data-method="POST"><h3>Password</h3><label for="p0">Current password</label><input id="p0" name="current" type="password" autocomplete="current-password" required>
      <label for="p1">New password <span class="opt">(8+ characters)</span></label><input id="p1" name="next" type="password" autocomplete="new-password" minlength="8" required><button class="btn" type="submit" style="margin-top:12px">Change password</button><p class="small muted">Changing your password signs you out everywhere else.</p></form></section>
    <div class="panel" id="policies"><h3>Terms &amp; privacy</h3>${LEGAL.accepted(u) ? `<p style="margin:0">You accepted version <strong>${esc(LEGAL.VERSION)}</strong> on ${date(u.terms_accepted_at)}.</p>` : `<p style="margin:0 0 8px">${u.terms_version ? `You accepted an earlier version (${esc(u.terms_version)}).` : 'You haven\'t recorded acceptance of the Terms of Service yet.'} You can keep using PairPlug; nothing is blocked.</p><button class="btn small" data-post="/api/account/terms" data-reload>Review below, then accept version ${esc(LEGAL.VERSION)}</button>`}
      <p class="small" style="margin:10px 0 0">${LEGAL.links()}</p></div>
    <aside class="panel">${u.is_seller ? `<p><a href="/dashboard">Seller dashboard →</a></p><p><a href="/dashboard/storefront">Customize storefront →</a></p><p><a href="/s/${esc(u.handle)}">View my storefront →</a></p>` : '<p class="muted small">PairPlug sellers are invited during the private beta.</p>'}<p><a href="/messages">Messages →</a></p><p><a href="/support">Contact PairPlug support →</a></p></aside></div>`;
  await page(req, res, { title: 'Account', body });
});
// Explicit, user-initiated acceptance of the current policy set (existing users are never marked automatically).
r.post('/api/account/terms', auth.requireUser, async (req, res) => { await LEGAL.recordAcceptance(req.user.id); await audit(req.user, 'terms_accepted', { type: 'user', id: req.user.id, detail: { version: LEGAL.VERSION } }); res.json({ ok: true, message: 'Thanks. Your acceptance was recorded.' }); });
r.post('/api/account/email', auth.requireUser, async (req, res) => {
  await auth.rateLimit(`acct-email:${req.user.id}`, 5, 3600);
  const addr = cleanLine(req.body.email, 200).toLowerCase();
  if (!auth.verifyPassword(String(req.body.password || ''), req.user.password_hash)) throw new HttpError(403, 'Your current password is incorrect.');
  if (!EMAIL_RE.test(addr)) throw new HttpError(422, 'Please fix the highlighted fields.', { email: 'Enter a valid email address.' });
  await tokens.requestEmailChange(req.user, addr);
  await audit(req.user, 'email_change_requested', { type: 'user', id: req.user.id });
  res.json({ ok: true, message: email.isConfigured() ? 'Check your new inbox to confirm the change. Your current email stays active until you do.' : 'Email delivery is not configured on this server yet, so the confirmation could not be sent. Your email has not changed.' });
});
r.post('/api/account/password', auth.requireUser, async (req, res) => {
  await auth.rateLimit(`acct-pw:${req.user.id}`, 8, 3600);
  if (!auth.verifyPassword(String(req.body.current || ''), req.user.password_hash)) throw new HttpError(403, 'Your current password is incorrect.');
  const pw = String(req.body.next || '');
  if (pw.length < 8 || pw.length > 200) throw new HttpError(422, 'Please fix the highlighted fields.', { next: 'Use at least 8 characters.' });
  if (pw === String(req.body.current || '')) throw new HttpError(422, 'Please fix the highlighted fields.', { next: 'Choose a password different from the current one.' });
  await tx(async () => { await q.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', auth.hashPassword(pw), req.user.id); await auth.destroyOtherSessions(req, req.user.id); });
  await audit(req.user, 'password_changed', { type: 'user', id: req.user.id });
  res.json({ ok: true, message: 'Password changed. Other devices were signed out.' });
});

// ---------- Password reset (only when real email delivery is configured; otherwise honestly unavailable) ----------
r.get('/forgot-password', async (req, res) => {
  await page(req, res, { title: 'Reset password', body: email.isConfigured()
    ? `<div class="narrow panel"><h1>Reset your password</h1><form data-api="/api/password/forgot" data-reload><label for="fe">Email</label><input id="fe" name="email" type="email" required><button class="btn block" style="margin-top:12px" type="submit">Send reset link</button></form></div>`
    : `<div class="narrow panel"><h1>Reset your password</h1><p>Automatic password reset isn't available yet because email delivery isn't set up. Please <a href="/support">contact PairPlug support</a> and we'll help you get back in.</p></div>` });
});
r.post('/api/password/forgot', async (req, res) => {
  if (!email.isConfigured()) throw new HttpError(503, 'Password reset by email is not available yet. Contact PairPlug support.');
  await auth.rateLimit(ipKey(req, 'forgot'), 10, 3600);
  const addr = cleanLine(req.body.email, 200).toLowerCase();
  if (addr) await auth.rateLimit(`forgot-mail:${addr}`, 3, 3600);
  const u = EMAIL_RE.test(addr) ? await q.get('SELECT * FROM users WHERE email = ? AND banned = 0', addr) : null;
  if (u) { try { await tokens.sendPasswordReset(u); } catch (e) { if (e.status !== 429) throw e; } }
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });     // identical response whether or not the account exists
});
r.get('/reset-password', async (req, res) => {
  noStore(res);
  await page(req, res, { title: 'Choose a new password', body: `<div class="narrow panel"><h1>Choose a new password</h1><form data-api="/api/password/reset" data-redirect="/login"><input type="hidden" name="token" value="${esc(String(req.query.token || ''))}">
    <label for="np">New password <span class="opt">(8+ characters)</span></label><input id="np" name="password" type="password" minlength="8" autocomplete="new-password" required><button class="btn block" style="margin-top:12px" type="submit">Set password</button></form></div>` });
});
r.post('/api/password/reset', async (req, res) => {
  if (!email.isConfigured()) throw new HttpError(503, 'Password reset by email is not available yet.');
  await auth.rateLimit(ipKey(req, 'reset'), 20, 3600);
  const pw = String(req.body.password || '');
  if (pw.length < 8 || pw.length > 200) throw new HttpError(422, 'Please fix the highlighted fields.', { password: 'Use at least 8 characters.' });
  await tx(async () => {
    const t = await tokens.consume(String(req.body.token || ''), 'reset_password');
    await q.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(pw), t.user_id);
    await q.run('DELETE FROM sessions WHERE user_id = ?', t.user_id);                         // every existing session is invalidated
    await q.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND lower(email) = lower(?)', now(), t.user_id, t.email);
    await audit('system', 'password_reset', { type: 'user', id: t.user_id });
  });
  res.json({ ok: true });
});

module.exports = { router: r };
