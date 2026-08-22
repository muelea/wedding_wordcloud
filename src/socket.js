'use strict';

/**
 * Socket.io wiring with per-event room isolation.
 *
 * This is the critical correctness fix over the prototype: the prototype
 * used io.emit()/socket.broadcast.emit() with no rooms at all, so every
 * connected client (across every wedding, if you ran it multi-tenant) saw
 * every event's data. Here, every socket must join a room keyed by the
 * event's slug before it can do anything, and every emit is scoped to that
 * room via io.to(slug).emit(...) — never io.emit(...) globally.
 *
 * A client picks its event by connecting with `?slug=<event-slug>` in the
 * Socket.io connection query string (see public/guest.html and
 * public/e-display.html). The slug is validated against the DB before the
 * socket is allowed to join the room; an unknown slug gets an error event
 * and is disconnected.
 */

const db = require('./db');
const crypto = require('crypto');
const { normalizeWord } = require('./words');

const GUEST_ID_RE = /^[a-f0-9]{32}$/;
const RECEIPT_RE = /^[A-Za-z0-9_-]{24}$/;

function attachSocketHandlers(io) {
  io.on('connection', (socket) => {
    const slug = socket.handshake.query && socket.handshake.query.slug;

    if (!slug || typeof slug !== 'string') {
      socket.emit('fatal-error', 'missing event slug');
      socket.disconnect(true);
      return;
    }

    const event = db.getEventBySlug(slug);
    if (!event) {
      socket.emit('fatal-error', 'unknown event');
      socket.disconnect(true);
      return;
    }

    // Room isolation: this socket only ever hears/emits events scoped to
    // its own event's room from this point on.
    socket.join(event.slug);
    socket.data.eventId = event.id;
    socket.data.slug = event.slug;
    const requestedGuestId = socket.handshake.query && socket.handshake.query.guestId;
    socket.data.guestId = typeof requestedGuestId === 'string' && GUEST_ID_RE.test(requestedGuestId)
      ? requestedGuestId
      : crypto.randomBytes(16).toString('hex');

    // Send current state to the newly connected client only (not the room —
    // no need to re-broadcast to everyone else just because one client joined).
    socket.emit('word-update', db.getWords(event.id));
    socket.emit('own-word-update', db.getWordContributions(event.id, socket.data.guestId));

    socket.on('submit-word', (rawWord) => {
      const word = normalizeWord(rawWord);
      if (!word) return;

      let receipt;
      try {
        receipt = db.addWordContribution(event.id, word, socket.data.guestId);
      } catch (error) {
        console.error(`[socket:${event.slug}] Could not save word contribution:`, error);
        socket.emit('word-error');
        return;
      }

      io.to(event.slug).emit('word-update', db.getWords(event.id));
      // Keep the normalized word as the first argument for backwards
      // compatibility; the private receipt is only sent to its submitter.
      socket.emit('word-accepted', word, receipt);
    });

    socket.on('remove-word', (payload, acknowledge) => {
      const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
      const receipt = payload && typeof payload === 'object' ? payload.receipt : payload;
      if (typeof receipt !== 'string' || !RECEIPT_RE.test(receipt)) {
        respond({ ok: false, error: 'not_found' });
        return;
      }

      let removedWord;
      try {
        removedWord = db.removeWordContribution(
          event.id,
          receipt,
          socket.data.guestId
        );
      } catch (error) {
        console.error(`[socket:${event.slug}] Could not remove word contribution:`, error);
        respond({ ok: false, error: 'server_error' });
        return;
      }
      if (!removedWord) {
        // Do not reveal whether the receipt exists for a different guest or
        // event; both cases intentionally look identical to the caller.
        respond({ ok: false, error: 'not_found' });
        return;
      }

      io.to(event.slug).emit('word-update', db.getWords(event.id));
      respond({ ok: true, word: removedWord });
    });

    // Relay theme changes to all connected clients FOR THIS EVENT ONLY.
    socket.on('theme-change', (theme) => {
      if (theme !== 'neon' && theme !== 'pastel') return;
      db.setEventTheme(event.id, theme);
      socket.to(event.slug).emit('theme-change', theme);
    });
  });
}

module.exports = { attachSocketHandlers };
