// Guards for admin-only areas. Session stores a lightweight user snapshot.
function requireAdmin(req, res, next) {
  if (req.session && req.session.user) return next();
  req.flash('error', 'Please log in to continue.');
  return res.redirect('/admin/login');
}

// Role gate for future multi-role setups (staff vs admin vs superadmin).
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.session?.user && roles.includes(req.session.user.role)) return next();
    return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access.', status: 403 });
  };
}

module.exports = { requireAdmin, requireRole };
