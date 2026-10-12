'use strict';
// Public legal pages. No login needed; cached briefly; nothing here depends on the viewer except the header.
const express = require('express');
const V = require('../views');
const LEGAL = require('../legal');
const config = require('../config');
const { esc } = require('../util');

const r = express.Router();
const show = (req, res, o) => res.set('Cache-Control', 'public, max-age=300').send(V.layout({ user: req.user, path: '/legal', title: o.title, description: o.description, body: o.body }));
r.get('/legal', (req, res) => show(req, res, LEGAL.index()));
for (const p of LEGAL.PAGES) r.get(p.path, (req, res) => show(req, res, LEGAL.render(p.key)));
r.get('/contact', (req, res) => {
  const email = config.supportEmail;
  const body = `<article class="legal contact"><h1>Contact PairPlug</h1>
<p class="lead">Email us about account access, orders, seller issues, scam and safety reports, appeals, privacy requests, or any general question.</p>
<div class="panel contact-card">
  <p style="margin:0 0 4px" class="muted small">Our support email</p>
  <p class="contact-email"><a href="${V.mailtoHref()}">${esc(email)}</a></p>
  <p class="contact-actions"><a class="btn" href="${V.mailtoHref()}">Email us</a> <a class="btn ghost" href="${esc(V.gmailHref())}" target="_blank" rel="noopener noreferrer">Open Gmail</a></p>
  <ul class="plain small">
    <li><strong>Email us</strong> opens a new draft in your device's default email app (Mail, Outlook and similar).</li>
    <li><strong>Open Gmail</strong> opens Gmail's compose page in a new tab with our address and a subject filled in. Gmail may ask you to sign in.</li>
    <li>Don't use either of those? Copy the address above into any email service: <span class="email-copy">${esc(email)}</span></li>
  </ul>
</div>
<p class="small muted">These buttons only open an email draft. Nothing is sent until you send it from your email app, and an email does not create a case or ticket automatically; there is no guaranteed response time. To report a scam with photos or an order attached, use the <a href="/support">Help &amp; reporting page</a> while logged in. Never email passwords or payment card numbers.</p>
<p><a class="btn ghost" href="/shop">← Back to shopping</a> <a class="btn ghost" href="/support">Help &amp; reporting</a></p></article>`;
  res.set('Cache-Control', 'public, max-age=300').send(V.layout({ user: req.user, path: '/contact', title: 'Contact', description: 'Contact PairPlug support by email.', body }));
});
r.get('/refunds', (req, res) => res.redirect(301, '/payments'));
r.get('/prohibited', (req, res) => res.redirect(301, '/rules'));
module.exports = { router: r };
