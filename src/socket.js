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
const { sourceHashForSocket } = require('./clientIdentity');
const rateLimits = require('./rateLimits');

const GUEST_ID_RE = /^[a-f0-9]{32}$/;
const RECEIPT_RE = /^[A-Za-z0-9_-]{24}$/;

function attachSocketHandlers(io) {
  io.on('connection', async (socket) => {
    const slug = socket.handshake.query && socket.handshake.query.slug;

    if (!slug || typeof slug !== 'string') {
      socket.emit('fatal-error', 'missing event slug');
      socket.disconnect(true);
      return;
    }

    let event;
    try {
      event = await db.getEventBySlug(slug);
      if (!event) {
        socket.emit('fatal-error', 'unknown event');
        socket.disconnect(true);
        return;
      }
    } catch (error) {
      console.error(`[socket:${slug}] Could not load event:`, error.message);
      socket.emit('fatal-error', 'event unavailable');
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
    socket.data.sourceHash = sourceHashForSocket(socket);
    const releaseSocket = rateLimits.acquireSocket(event.id, socket.data.sourceHash);
    if (!releaseSocket) {
      socket.emit('fatal-error', 'rate_limited');
      socket.disconnect(true);
      return;
    }
    socket.once('disconnect', releaseSocket);

    // Send current state to the newly connected client only (not the room —
    // no need to re-broadcast to everyone else just because one client joined).
    try {
      const [words, contributions] = await Promise.all([
        db.getWords(event.id),
        db.getWordContributions(event.id, socket.data.guestId),
      ]);
      socket.emit('word-update', words);
      socket.emit('own-word-update', contributions);
    } catch (error) {
      console.error(`[socket:${event.slug}] Could not load current state:`, error.message);
      socket.emit('fatal-error', 'event unavailable');
      socket.disconnect(true);
      return;
    }

    socket.on('submit-word', async (rawWord) => {
      const word = normalizeWord(rawWord, event.locale);
      if (!word) return;
      const guestKey = `${event.id}:${socket.data.guestId}`;
      if (!rateLimits.consumeTokens([
        { name: 'word:burst', key: guestKey, ...rateLimits.LIMITS.wordBurst },
        { name: 'word:guest', key: guestKey, ...rateLimits.LIMITS.wordGuest },
        {
          name: 'word:source',
          key: `${event.id}:${socket.data.sourceHash}`,
          ...rateLimits.LIMITS.wordSource,
        },
      ])) {
        socket.emit('word-error', { error: 'rate_limited' });
        return;
      }

      let receipt;
      let words;
      try {
        receipt = await db.addWordContribution(event.id, word, socket.data.guestId);
        words = await db.getWords(event.id);
      } catch (error) {
        console.error(`[socket:${event.slug}] Could not save word contribution:`, error);
        const limited = new Set([
          'guest_contribution_limit',
          'event_contribution_limit',
          'unique_word_limit',
        ]).has(error?.code);
        socket.emit('word-error', { error: limited ? 'limit_reached' : 'server_error' });
        return;
      }

      io.to(event.slug).emit('word-update', words);
      // Keep the normalized word as the first argument for backwards
      // compatibility; the private receipt is only sent to its submitter.
      socket.emit('word-accepted', word, receipt);
    });

    socket.on('remove-word', async (payload, acknowledge) => {
      const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
      if (!rateLimits.consume([{
        name: 'word:remove',
        key: `${event.id}:${socket.data.guestId}`,
        ...rateLimits.LIMITS.wordRemoveGuest,
      }])) {
        respond({ ok: false, error: 'rate_limited' });
        return;
      }
      const receipt = payload && typeof payload === 'object' ? payload.receipt : payload;
      if (typeof receipt !== 'string' || !RECEIPT_RE.test(receipt)) {
        respond({ ok: false, error: 'not_found' });
        return;
      }

      let removedWord;
      let words;
      try {
        removedWord = await db.removeWordContribution(
          event.id,
          receipt,
          socket.data.guestId
        );
        if (removedWord) words = await db.getWords(event.id);
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

      io.to(event.slug).emit('word-update', words);
      respond({ ok: true, word: removedWord });
    });

    // Relay theme changes to all connected clients FOR THIS EVENT ONLY.
    socket.on('theme-change', async (theme) => {
      if (theme !== 'neon' && theme !== 'pastel') return;
      if (!rateLimits.consume([
        {
          name: 'theme:guest',
          key: `${event.id}:${socket.data.guestId}`,
          ...rateLimits.LIMITS.themeGuest,
        },
        { name: 'theme:event', key: event.id, ...rateLimits.LIMITS.themeEvent },
      ])) {
        socket.emit('theme-error', { error: 'rate_limited' });
        return;
      }
      try {
        await db.setEventTheme(event.id, theme);
        socket.to(event.slug).emit('theme-change', theme);
      } catch (error) {
        console.error(`[socket:${event.slug}] Could not save theme:`, error.message);
        socket.emit('theme-error');
      }
    });
  });
}

module.exports = { attachSocketHandlers };
