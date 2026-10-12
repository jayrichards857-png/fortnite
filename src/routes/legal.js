'use strict';
// Public legal pages. No login needed; cached briefly; nothing here depends on the viewer except the header.
const express = require('express');
const V = require('../views');
const LEGAL = require('../legal');

const r = express.Router();
const show = (req, res, o) => res.set('Cache-Control', 'public, max-age=300').send(V.layout({ user: req.user, path: '/legal', title: o.title, description: o.description, body: o.body }));
r.get('/legal', (req, res) => show(req, res, LEGAL.index()));
for (const p of LEGAL.PAGES) r.get(p.path, (req, res) => show(req, res, LEGAL.render(p.key)));
r.get('/refunds', (req, res) => res.redirect(301, '/payments'));
r.get('/prohibited', (req, res) => res.redirect(301, '/rules'));
module.exports = { router: r };
