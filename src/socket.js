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
const { normalizeWord } = require('./words');

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

    // Send current state to the newly connected client only (not the room —
    // no need to re-broadcast to everyone else just because one client joined).
    socket.emit('word-update', db.getWords(event.id));

    socket.on('submit-word', (rawWord) => {
      const word = normalizeWord(rawWord);
      if (!word) return;

      db.upsertWord(event.id, word);

      io.to(event.slug).emit('word-update', db.getWords(event.id));
      socket.emit('word-accepted', word);
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
