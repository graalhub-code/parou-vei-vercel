const crypto = require('crypto');
const game = require('../lib/game');
const store = require('../lib/redis');
const { broadcastEvents } = require('../lib/pusher');

function makePlayer(nickname) {
  return {
    id: crypto.randomUUID(),
    nickname: game.capitalizeFirst((nickname || 'Jogador').slice(0, 16).trim()),
    score: 0,
  };
}

function findPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

async function broadcastRoomState(code, room, events) {
  events.push({ type: 'room_state', room: game.roomPublicState(room) });
  return events;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const { type, playerId } = body;

  try {
    // ---- ações que não dependem de uma sala já existente ----
    if (type === 'create_room') {
      const player = makePlayer(body.nickname);
      const room = game.newRoom(player);
      await store.saveRoom(room, game.ROOM_TTL_SECONDS);
      res.status(200).json({ ok: true, you: player.id, room: game.roomPublicState(room) });
      return;
    }

    if (type === 'join_room') {
      const code = (body.code || '').toUpperCase().trim();
      if (!code) { res.status(400).json({ ok: false, error: 'Digite o código da sala.' }); return; }
      const result = await store.withRoomLock(code, async () => {
        const room = await store.getRoom(code);
        if (!room) return { error: 'Sala não encontrada.' };
        if (room.phase !== 'lobby') return { error: 'Essa partida já começou.' };
        if (room.players.length >= game.MAX_PLAYERS) return { error: 'Sala cheia (máximo 10).' };
        const player = makePlayer(body.nickname);
        room.players.push(player);
        await store.saveRoom(room, game.ROOM_TTL_SECONDS);
        await broadcastEvents(code, [{ type: 'room_state', room: game.roomPublicState(room) }]);
        return { player, room };
      });
      if (result.error) { res.status(400).json({ ok: false, error: result.error }); return; }
      res.status(200).json({ ok: true, you: result.player.id, room: game.roomPublicState(result.room) });
      return;
    }

    // ---- daqui pra baixo, toda ação precisa de code + sala existente ----
    const code = (body.code || '').toUpperCase().trim();
    if (!code) { res.status(400).json({ ok: false, error: 'Sala não encontrada.' }); return; }

    if (type === 'draft') {
      const room = await store.getRoom(code);
      if (!room || room.phase !== 'playing') { res.status(200).json({ ok: true }); return; }
      await store.setAnswer(code, playerId, body.category, body.value);
      res.status(200).json({ ok: true });
      return;
    }

    if (type === 'submit_final') {
      const room = await store.getRoom(code);
      if (!room || room.phase !== 'playing' || !room.frozen) { res.status(200).json({ ok: true }); return; }
      await store.mergeAnswers(code, playerId, body.answers);
      res.status(200).json({ ok: true });
      return;
    }

    if (type === 'vote_challenge') {
      await store.withRoomLock(code, async () => {
        const room = await store.getRoom(code);
        if (!room || !room.activeChallenge || playerId === room.activeChallenge.targetPlayerId) return;
        room.activeChallenge.votes[playerId] = !!body.valid;
        await store.saveRoom(room, game.ROOM_TTL_SECONDS);
      });
      res.status(200).json({ ok: true });
      return;
    }

    // Ações que mudam o estado "oficial" da sala usam o lock.
    const out = await store.withRoomLock(code, async () => {
      const room = await store.getRoom(code);
      if (!room) return { error: 'Sala não encontrada.' };
      let events = [];

      switch (type) {
        case 'set_rounds': {
          if (playerId !== room.hostId || room.phase !== 'lobby') break;
          const n = parseInt(body.rounds, 10);
          if (n >= 5 && n <= 10) room.totalRounds = n;
          events = await broadcastRoomState(code, room, events);
          break;
        }
        case 'set_vote_duration': {
          if (playerId !== room.hostId || room.phase !== 'lobby') break;
          const ms = parseInt(body.voteDurationMs, 10);
          if (game.VOTE_DURATION_OPTIONS.includes(ms)) room.voteDurationMs = ms;
          events = await broadcastRoomState(code, room, events);
          break;
        }
        case 'set_tiebreak': {
          if (playerId !== room.hostId || room.phase !== 'lobby') break;
          room.tiebreakEnabled = !!body.enabled;
          events = await broadcastRoomState(code, room, events);
          break;
        }
        case 'set_bahia': {
          if (playerId !== room.hostId || room.phase !== 'lobby') break;
          room.bahiaEnabled = !!body.enabled;
          events = await broadcastRoomState(code, room, events);
          break;
        }
        case 'set_room_code': {
          if (playerId !== room.hostId || room.phase !== 'lobby') break;
          const newCode = (body.newCode || '').toUpperCase().trim();
          if (!/^[A-Z0-9]{4,8}$/.test(newCode)) return { error: 'Código inválido. Use de 4 a 8 letras ou números.' };
          if (newCode !== room.code) {
            const taken = await store.getRoom(newCode);
            if (taken) return { error: 'Esse código já está em uso.' };
            const oldCode = room.code;
            room.code = newCode;
            await store.saveRoom(room, game.ROOM_TTL_SECONDS);
            await store.deleteRoom(oldCode);
          }
          events = await broadcastRoomState(code, room, events);
          return { room, events, renamedTo: room.code };
        }
        case 'start_game': {
          if (playerId !== room.hostId || room.phase !== 'lobby') break;
          if (room.players.length < 2) return { error: 'Precisa de pelo menos 2 jogadores pra começar.' };
          room.currentRound = 1;
          room.gameStats = { stopCounts: {}, dupCounts: {} };
          room.tiebreakDone = false;
          room.tiebreakOrder = null;
          room.bahiaRoundNumbers = room.bahiaEnabled ? game.pickBahiaRoundNumbers(room.totalRounds) : [];
          await store.clearAnswers(code);
          events = [game.startRound(room)];
          break;
        }
        case 'parei': {
          if (room.phase !== 'playing' || room.frozen) break;
          room.frozen = true;
          room.stoppedByPlayerId = playerId;
          room.freezeDeadline = Date.now() + game.FREEZE_GRACE_MS;
          await store.mergeAnswers(code, playerId, body.answers);
          const stopper = findPlayer(room, playerId);
          events = [{ type: 'frozen', by: stopper ? stopper.nickname : 'alguém', graceMs: game.FREEZE_GRACE_MS }];
          break;
        }
        case 'freeze_timeout': {
          if (room.phase !== 'playing' || !room.frozen) break;
          if (Date.now() < room.freezeDeadline - 200) break;
          const answers = await store.getAnswers(code);
          const ev = game.finalizeRound(room, answers, room.stoppedByPlayerId);
          if (ev) events = [ev];
          break;
        }
        case 'round_timeout': {
          if (room.phase !== 'playing') break;
          if (Date.now() < room.roundDeadline - 200) break;
          const answers = await store.getAnswers(code);
          const ev = game.finalizeRound(room, answers, null);
          if (ev) events = [ev];
          break;
        }
        case 'challenge': {
          if (room.phase !== 'results' || room.activeChallenge) break;
          const { category, targetPlayerId } = body;
          const catResults = room.lastResults && room.lastResults.perCategory[category];
          if (!catResults) break;
          const entry = catResults.find(e => e.playerId === targetPlayerId);
          if (!entry || entry.points === 0 || targetPlayerId === playerId) break;
          const challenger = findPlayer(room, playerId);
          room.activeChallenge = {
            category, targetPlayerId, entry, votes: {},
            raisedBy: challenger ? challenger.nickname : 'alguém',
            deadline: Date.now() + room.voteDurationMs,
          };
          events = [{
            type: 'challenge_open', category, targetPlayerId,
            targetNickname: entry.nickname, value: entry.value,
            raisedBy: room.activeChallenge.raisedBy, voteMs: room.voteDurationMs,
          }];
          break;
        }
        case 'challenge_timeout': {
          if (!room.activeChallenge) break;
          if (Date.now() < room.activeChallenge.deadline - 200) break;
          const ev = game.resolveChallenge(room);
          if (ev) events = [ev];
          break;
        }
        case 'tiebreak_answer': {
          if (room.phase !== 'tiebreak' || !room.tiebreakPlayers.includes(playerId)) break;
          if (room.tiebreakAnswers[playerId]) break;
          room.tiebreakAnswers[playerId] = { value: body.value || '', submittedAt: Date.now() };
          if (room.tiebreakPlayers.every(id => room.tiebreakAnswers[id])) {
            events = game.resolveTiebreak(room);
          }
          break;
        }
        case 'tiebreak_timeout': {
          if (room.phase !== 'tiebreak' || room.tiebreakDone) break;
          if (Date.now() < room.tiebreakDeadline - 200) break;
          events = game.resolveTiebreak(room);
          break;
        }
        case 'next_round': {
          if (playerId !== room.hostId || room.phase !== 'results') break;
          await store.clearAnswers(code);
          events = game.nextRoundOrEnd(room);
          break;
        }
        case 'play_again': {
          if (playerId !== room.hostId || room.phase !== 'podium') break;
          room.phase = 'lobby';
          room.currentRound = 0;
          room.currentCategories = [];
          room.currentBahiaCategory = null;
          room.remainingCategories = [...game.CATEGORY_POOL];
          room.tiebreakDone = false;
          room.tiebreakOrder = null;
          room.tiebreakPlayers = [];
          room.bahiaRoundNumbers = [];
          room.isBahiaRound = false;
          room.gameStats = { stopCounts: {}, dupCounts: {} };
          for (const p of room.players) p.score = 0;
          await store.clearAnswers(code);
          events = await broadcastRoomState(code, room, events);
          break;
        }
        case 'leave_room': {
          const idx = room.players.findIndex(p => p.id === playerId);
          if (idx !== -1) {
            room.players.splice(idx, 1);
            if (room.hostId === playerId && room.players.length > 0) {
              room.hostId = room.players[0].id;
            }
          }
          if (room.players.length === 0) {
            await store.deleteRoom(code);
            return { room: null, events: [] };
          }
          events = await broadcastRoomState(code, room, events);
          break;
        }
        default:
          return { error: 'Ação desconhecida.' };
      }

      if (events.length > 0) {
        await store.saveRoom(room, game.ROOM_TTL_SECONDS);
        await broadcastEvents(room.code, events);
      }
      return { room, events };
    });

    if (out && out.error) { res.status(400).json({ ok: false, error: out.error }); return; }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || 'Erro interno.' });
  }
};
