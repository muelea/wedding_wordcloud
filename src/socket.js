'use strict';

/**
 * Socket.io wiring with per-event room isolation.
 *
 * This is the critical correctness fix over the prototype: the prototype
 * used io.emit()/socket.broadcast.emit() with no rooms at all, so every
 * connected client (across every event, if you ran it multi-tenant) saw
 * every event's data. Here, every socket must join a room keyed by the
 * event's slug before it can do anything, and every emit is scoped to that
 * room via io.to(slug).emit(...) — never io.emit(...) globally.
 *
 * A client picks its event by connecting with `?slug=<event-slug>` in the
 * Socket.io connection query string (see views/display.ejs). The slug is
 * validated against the DB before the
 * socket is allowed to join the room; an unknown slug gets an error event
 * and is disconnected.
 */

const db = require('./db');
const crypto = require('crypto');
const { normalizeWordInput } = require('./words');
const { sourceHashForSocket } = require('./clientIdentity');
const rateLimits = require('./rateLimits');
const performanceProbe = require('./performanceProbe');
const log = require('./structuredLog');
const { createWordUpdateBroadcaster } = require('./wordBroadcasts');
const { createSocketEventCache } = require('./socketEventCache');
const { createSocketOwnershipLoader } = require('./socketOwnershipLoader');

const GUEST_ID_RE = /^[a-f0-9]{32}$/;
const RECEIPT_RE = /^[A-Za-z0-9_-]{24}$/;
const MAX_INITIAL_ACTIONS = 3;
const INITIALIZATION_TIMEOUT_MS = 15_000;

function attachSocketHandlers(io, { wordBroadcasts } = {}) {
  const broadcasts = wordBroadcasts || createWordUpdateBroadcaster({ io, getWords: db.getWords });
  const eventCache = createSocketEventCache({ getEventBySlug: db.getEventBySlug });
  const ownershipLoader = createSocketOwnershipLoader({
    loadBatch: db.getWordContributionsForOwners,
  });
  let stopped = false;
  io.on('connection', (socket) => {
    const slug = socket.handshake.query && socket.handshake.query.slug;

    if (!slug || typeof slug !== 'string') {
      socket.emit('fatal-error', 'missing event slug');
      socket.disconnect(true);
      return;
    }

    let event;
    let releaseSocket = null;
    let initialReader = null;
    let ready = false;
    let pendingActions = 0;
    let finishInitialization;
    const initialized = new Promise((resolve) => { finishInitialization = resolve; });
    const active = () => socket.connected && !stopped;
    function fail(message) {
      finishInitialization(false);
      if (socket.connected) {
        socket.emit('fatal-error', message);
        socket.disconnect(true);
      }
    }
    const timer = setTimeout(() => fail('event unavailable'), INITIALIZATION_TIMEOUT_MS);
    timer.unref();
    // Install cleanup before the first database await: a client can leave
    // during a cold lookup, before it ever acquires a room slot.
    socket.once('disconnect', () => {
      clearTimeout(timer);
      finishInitialization(false);
      initialReader?.release();
      if (releaseSocket) {
        releaseSocket();
        releaseSocket = null;
        performanceProbe.recordSocketDisconnected(event.id);
      }
    });

    async function waitUntilReady(onLimited) {
      if (!active()) return false;
      if (ready) return true;
      if (pendingActions >= MAX_INITIAL_ACTIONS) {
        onLimited();
        return false;
      }
      pendingActions += 1;
      const allowed = await initialized;
      pendingActions -= 1;
      return allowed && active();
    }

    // Register synchronously so Socket.io's reconnect buffer cannot flush
    // into an unhandled event. Only three small actions may await hydration.
    socket.on('submit-word', async (rawWord) => {
      if (typeof rawWord !== 'string' || rawWord.length > 4096) return;
      if (!await waitUntilReady(() => {
        performanceProbe.recordOperation('wordRateLimited');
        socket.emit('word-error', { error: 'rate_limited' });
      })) return;
      const normalized = normalizeWordInput(rawWord, event.locale);
      if (!normalized.word) {
        if (normalized.error === 'unsupported_emoji') {
          socket.emit('word-error', { error: normalized.error });
        }
        return;
      }
      const word = normalized.word;
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
        performanceProbe.recordOperation('wordRateLimited');
        socket.emit('word-error', { error: 'rate_limited' });
        return;
      }

      let receipt;
      try {
        receipt = await db.addWordContribution(event.id, word, socket.data.guestId);
      } catch (error) {
        performanceProbe.recordOperation('wordFailed');
        log.error('socket_word_submit_failed', {
          eventId: event.id,
          errorCode: log.errorCode(error, 'word_submit_failed'),
        });
        const limited = new Set([
          'guest_contribution_limit',
          'event_contribution_limit',
          'unique_word_limit',
        ]).has(error?.code);
        socket.emit('word-error', { error: limited ? error.code : 'server_error' });
        return;
      }

      // The transaction has committed. Schedule one complete room snapshot
      // for the whole 100 ms burst instead of querying and broadcasting once
      // per accepted contribution.
      broadcasts.schedule(event, { ownerId: socket.data.guestId });
      performanceProbe.recordOperation('wordAccepted');
      // Only the submitter receives the normalized word and its private receipt.
      socket.emit('word-accepted', word, receipt);
    });

    socket.on('remove-word', async (payload, acknowledge) => {
      const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
      const receipt = payload && typeof payload === 'object' ? payload.receipt : payload;
      if (typeof receipt !== 'string' || !RECEIPT_RE.test(receipt)) {
        performanceProbe.recordOperation('wordRemoveNotFound');
        respond({ ok: false, error: 'not_found' });
        return;
      }
      // Do not retain the caller's arbitrary object while waiting.
      payload = null;
      if (!await waitUntilReady(() => {
        performanceProbe.recordOperation('wordRemoveRateLimited');
        respond({ ok: false, error: 'rate_limited' });
      })) return;
      if (!rateLimits.consume([{
        name: 'word:remove',
        key: `${event.id}:${socket.data.guestId}`,
        ...rateLimits.LIMITS.wordRemoveGuest,
      }])) {
        performanceProbe.recordOperation('wordRemoveRateLimited');
        respond({ ok: false, error: 'rate_limited' });
        return;
      }
      let removedWord;
      try {
        removedWord = await db.removeWordContribution(
          event.id,
          receipt,
          socket.data.guestId
        );
      } catch (error) {
        performanceProbe.recordOperation('wordRemoveFailed');
        log.error('socket_word_remove_failed', {
          eventId: event.id,
          errorCode: log.errorCode(error, 'word_remove_failed'),
        });
        respond({ ok: false, error: 'server_error' });
        return;
      }
      if (!removedWord) {
        performanceProbe.recordOperation('wordRemoveNotFound');
        // Do not reveal whether the receipt exists for a different guest or
        // event; both cases intentionally look identical to the caller.
        respond({ ok: false, error: 'not_found' });
        return;
      }

      broadcasts.schedule(event, { ownerId: socket.data.guestId });
      performanceProbe.recordOperation('wordRemoved');
      respond({ ok: true, word: removedWord });
    });

    async function initialize() {
      try {
        event = await eventCache.get(slug);
        if (!active()) return;
        if (!event) return fail('unknown event');
        socket.data.eventId = event.id;
        socket.data.slug = event.slug;
        const requestedGuestId = socket.handshake.query.guestId;
        socket.data.guestId = typeof requestedGuestId === 'string' && GUEST_ID_RE.test(requestedGuestId)
          ? requestedGuestId : crypto.randomBytes(16).toString('hex');
        socket.data.sourceHash = sourceHashForSocket(socket);
        releaseSocket = rateLimits.acquireSocket(event.id, socket.data.sourceHash);
        if (!releaseSocket) {
          performanceProbe.recordOperation('socketRateLimited');
          return fail('rate_limited');
        }
        performanceProbe.recordSocketConnected(event.id);
        socket.join(event.slug);
        const reader = broadcasts.beginInitial(event, socket.data.guestId);
        initialReader = reader;
        const broadcastVersion = reader.broadcastVersion;
        const words = broadcasts.loadInitial(event).then((snapshot) => {
          // The socket already receives room broadcasts. Never follow a newer
          // broadcast with an older initial read, even if receipts are slow.
          if (active() && reader.broadcastVersion === broadcastVersion) socket.emit('word-update', snapshot);
        });
        const receipts = (async () => {
          while (active()) {
            const version = reader.ownershipVersion;
            const contributions = await ownershipLoader.load(event.id, socket.data.guestId);
            if (!active()) return;
            // Reset/admin removal or another connection for this owner may
            // invalidate private receipts. Other guests do not delay this read.
            if (version !== reader.ownershipVersion) continue;
            socket.emit('own-word-update', contributions);
            return;
          }
        })();
        await Promise.all([words, receipts]);
        if (active()) {
          ready = true;
          finishInitialization(true);
        }
      } catch (error) {
        if (active()) {
          log.error('socket_initialization_failed', {
            eventId: event?.id,
            errorCode: log.errorCode(error, 'state_load_failed'),
          });
          fail('event unavailable');
        }
      } finally {
        clearTimeout(timer);
        initialReader?.release();
        initialReader = null;
        finishInitialization(false);
      }
    }
    initialize();
  });
  return {
    stop() {
      stopped = true;
      eventCache.stop();
      ownershipLoader.stop();
      if (!wordBroadcasts) broadcasts.stop();
    },
  };
}

module.exports = { attachSocketHandlers };
