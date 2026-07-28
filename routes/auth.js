const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const User = require('../models/User');
const { loginRules, collect } = require('../middleware/validators');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

router.get('/admin/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login' });
});

router.post('/admin/login', loginLimiter, loginRules, async (req, res) => {
  const errors = collect(req);
  if (errors) {
    req.flash('error', errors.join(' '));
    return res.redirect('/admin/login');
  }
  const user = await User.findOne({ username: String(req.body.username).toLowerCase() });
  if (!user || !(await user.verifyPassword(req.body.password))) {
    req.flash('error', 'Invalid username or password.');
    return res.redirect('/admin/login');
  }
  req.session.user = { id: user._id, name: user.name, username: user.username, role: user.role };
  req.flash('success', `Welcome back, ${user.name}.`);
  res.redirect('/admin');
});

router.delete('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

module.exports = router;
