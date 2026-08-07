const { body, validationResult } = require('express-validator');

const bookingRules = [
  body('clientName').trim().notEmpty().withMessage('Name is required.').isLength({ max: 120 }),
  body('whatsapp').trim().notEmpty().withMessage('WhatsApp number is required.')
    .matches(/^[+0-9][0-9\s()-]{6,}$/).withMessage('Enter a valid phone number.'),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email.').normalizeEmail(),
  body('bookingDate').notEmpty().withMessage('Pick a service date.').isISO8601().withMessage('Invalid date.')
    .custom((v) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (new Date(v) < today) throw new Error("Service date can't be in the past.");
      return true;
    }),
  body('lat').custom((v, { req }) => {
    if (!Number.isFinite(parseFloat(v)) || !Number.isFinite(parseFloat(req.body.lng))) {
      throw new Error('Please pick your service location on the map.');
    }
    return true;
  }),
  body('tanks').custom((v) => {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Add at least one tank.');
    // Service type is now chosen per tank; if present it must be a known tier.
    for (const t of arr) {
      if (t.tier != null && !['standard', 'preserve'].includes(t.tier)) {
        throw new Error('Choose a valid service type for each tank.');
      }
    }
    return true;
  }),
];

const loginRules = [
  body('username').trim().notEmpty().withMessage('Username is required.'),
  body('password').notEmpty().withMessage('Password is required.'),
];

function collect(req) {
  const result = validationResult(req);
  return result.isEmpty() ? null : result.array().map((e) => e.msg);
}

module.exports = { bookingRules, loginRules, collect };
