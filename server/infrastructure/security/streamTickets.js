const { randomBytes } = require('node:crypto');

const TICKET_TTL_MS = 30000;
const MAX_OUTSTANDING_TICKETS = 5000;

function createStreamTicketStore({ ttlMs = TICKET_TTL_MS, now = () => Date.now() } = {}) {
  const tickets = new Map();

  function sweep() {
    const current = now();
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= current) tickets.delete(ticket);
    }
  }

  function issue(claims) {
    sweep();
    if (tickets.size >= MAX_OUTSTANDING_TICKETS) {
      const oldest = tickets.keys().next().value;
      tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { claims: Object.freeze({ ...claims }), expiresAt: now() + ttlMs });
    return { ticket, expiresInSeconds: Math.floor(ttlMs / 1000) };
  }

  function consume(ticket) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!entry || entry.expiresAt <= now()) return null;
    return entry.claims;
  }

  return { issue, consume, size: () => tickets.size };
}

module.exports = { createStreamTicketStore, TICKET_TTL_MS };
