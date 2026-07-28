const { body, validationResult } = require('express-validator');

const bookingRules = [
  body('clientName').trim().notEmpty().withMessage('Name is required.').isLength({ max: 120 }),
  body('whatsapp').trim().notEmpty().withMessage('WhatsApp number is required.')
    .matches(/^[+0-9][0-9\s()-]{6,}$/).withMessage('Enter a valid phone number.'),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email.').normalizeEmail(),
  body('serviceTier').isIn(['standard', 'preserve']).withMessage('Choose a service tier.'),
  body('bookingDate').notEmpty().withMessage('Pick a service date.').isISO8601().withMessage('Invalid date.'),
  body('tanks').custom((v) => {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Add at least one tank.');
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
