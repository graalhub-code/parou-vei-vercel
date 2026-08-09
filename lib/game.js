// Motor de jogo puro (sem I/O). Recebe o estado da sala (room) e retorna
// eventos para transmitir via Pusher. Nao guarda estado em memoria: quem
// chama (api/action.js) e responsavel por carregar/salvar a sala no Redis.

const CATEGORY_POOL = [
  'Nome', 'Cor', 'Animal', 'Fruta', 'Objeto', 'Profissão', 'País', 'Filme',
  'Marca', 'Comida', 'Esporte', 'Cantor ou banda', 'Personagem', 'Roupa',
  'Instrumento musical', 'Time de futebol', 'Sobrenome', 'Cidade', 'Bebida', 'Verbo',
];
const BAHIA_CATEGORY_POOL = [
  'Gíria baiana', 'Comida baiana', 'Ponto turístico da Bahia', 'Cantor ou banda baiano',
  'Bloco de carnaval', 'Expressão baiana', 'Praia baiana', 'Prato típico baiano',
];
const CATEGORIES_PER_ROUND = 4;
const MAX_PLAYERS = 10;
const ROUND_MAX_MS = 60000;
const FREEZE_GRACE_MS = 1000;
const DEFAULT_VOTE_MS = 10000;
const VOTE_DURATION_OPTIONS = [5000, 10000, 15000, 20000];
const TIEBREAK_MS = 20000;
const LETTERS = 'ABCDEFGHIJLMNOPQRSTU'.split('');
const ROOM_TTL_SECONDS = 6 * 60 * 60; // 6h de inatividade derruba a sala

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function capitalizeFirst(text) {
  if (!text) return text;
  return text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1);
}

function pickRoundCategories(room, count = CATEGORIES_PER_ROUND) {
  if (room.remainingCategories.length < count) {
    room.remainingCategories = [...CATEGORY_POOL];
  }
  const pool = [...room.remainingCategories];
  const picked = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  room.remainingCategories = room.remainingCategories.filter(c => !picked.includes(c));
  return picked;
}

function pickBahiaRoundNumbers(totalRounds) {
  if (totalRounds <= 2) return [];
  const quantidade = Math.min(totalRounds - 2, Math.max(2, Math.ceil(totalRounds / 3)));
  const candidatos = [];
  for (let r = 2; r <= totalRounds - 1; r++) candidatos.push(r);
  const escolhidas = [];
  for (let i = 0; i < quantidade && candidatos.length > 0; i++) {
    const idx = Math.floor(Math.random() * candidatos.length);
    escolhidas.push(candidatos[idx]);
    candidatos.splice(idx, 1);
  }
  return escolhidas;
}

function pickRandomCategories(pool, count) {
  const copy = [...pool];
  const picked = [];
  for (let i = 0; i < count && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return picked;
}

function buildGameStats(room) {
  function topEntries(counts) {
    const values = Object.values(counts);
    const max = values.length ? Math.max(...values) : 0;
    if (max <= 0) return { count: 0, players: [] };
    const ids = Object.keys(counts).filter(id => counts[id] === max);
    const players = ids.map(id => {
      const p = room.players.find(pp => pp.id === id);
      return p ? p.nickname : 'Jogador';
    });
    return { count: max, players };
  }
  const stats = room.gameStats || { stopCounts: {}, dupCounts: {} };
  return {
    maisRapido: topEntries(stats.stopCounts),
    maisRepetiu: topEntries(stats.dupCounts),
  };
}

function buildLeaderboard(room) {
  const order = room.tiebreakOrder || [];
  return room.players
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return 0;
    })
    .map(p => ({ id: p.id, nickname: p.nickname, score: p.score }));
}

function roomPublicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    letter: room.letter,
    categories: room.currentCategories || [],
    bahiaCategory: room.currentBahiaCategory || null,
    voteDurationMs: room.voteDurationMs,
    tiebreakEnabled: room.tiebreakEnabled,
    bahiaEnabled: room.bahiaEnabled,
    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score })),
  };
}

function newRoom(hostPlayer) {
  const code = genCode();
  return {
    code,
    hostId: hostPlayer.id,
    phase: 'lobby',
    totalRounds: 7,
    currentRound: 0,
    letter: null,
    currentCategories: [],
    currentBahiaCategory: null,
    gameStats: { stopCounts: {}, dupCounts: {} },
    remainingCategories: [...CATEGORY_POOL],
    frozen: false,
    freezeDeadline: null,
    stoppedByPlayerId: null,
    players: [hostPlayer],
    roundDeadline: null,
    lastResults: null,
    activeChallenge: null,
    voteDurationMs: DEFAULT_VOTE_MS,
    tiebreakEnabled: true,
    bahiaEnabled: false,
    bahiaRoundNumbers: [],
    isBahiaRound: false,
    tiebreakDone: false,
    tiebreakOrder: null,
    tiebreakPlayers: [],
    tiebreakAnswers: null,
    tiebreakDeadline: null,
    tiebreakLetter: null,
    tiebreakCategory: null,
    updatedAt: Date.now(),
  };
}

function startRound(room) {
  room.phase = 'playing';
  room.letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  const isBahia = room.bahiaEnabled && (room.bahiaRoundNumbers || []).includes(room.currentRound);
  room.isBahiaRound = isBahia;
  let bahiaCategory = null;
  if (isBahia) {
    const normais = pickRoundCategories(room, CATEGORIES_PER_ROUND - 1);
    bahiaCategory = pickRandomCategories(BAHIA_CATEGORY_POOL, 1)[0];
    const posicao = Math.floor(Math.random() * (normais.length + 1));
    normais.splice(posicao, 0, bahiaCategory);
    room.currentCategories = normais;
  } else {
    room.currentCategories = pickRoundCategories(room);
  }
  room.currentBahiaCategory = bahiaCategory;
  room.frozen = false;
  room.freezeDeadline = null;
  room.stoppedByPlayerId = null;
  room.roundDeadline = Date.now() + ROUND_MAX_MS;

  return {
    type: 'round_start',
    letter: room.letter,
    categories: room.currentCategories,
    bahiaCategory,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    maxMs: ROUND_MAX_MS,
    isBahia,
  };
}

// answers: { [playerId]: { [categoria]: valor } } - montado pelo chamador a
// partir do hash de respostas no Redis.
function scoreRound(room, answers) {
  const perCategory = {};
  for (const cat of room.currentCategories) {
    const entries = room.players.map(p => {
      const raw = (answers[p.id] && answers[p.id][cat]) || '';
      const val = raw.trim();
      const valid = val.length > 0 && val[0].toLocaleUpperCase('pt-BR') === room.letter;
      return { playerId: p.id, nickname: p.nickname, value: capitalizeFirst(val), valid };
    });
    const normalizedCounts = {};
    for (const e of entries) {
      if (!e.valid) continue;
      const key = e.value.toLocaleLowerCase('pt-BR');
      normalizedCounts[key] = (normalizedCounts[key] || 0) + 1;
    }
    perCategory[cat] = entries.map(e => {
      let points = 0;
      if (e.valid) {
        const key = e.value.toLocaleLowerCase('pt-BR');
        points = normalizedCounts[key] > 1 ? 5 : 10;
      }
      return { ...e, points };
    });
  }

  const roundTotals = {};
  for (const p of room.players) roundTotals[p.id] = 0;
  for (const cat of room.currentCategories) {
    for (const e of perCategory[cat]) roundTotals[e.playerId] += e.points;
  }
  for (const p of room.players) p.score += roundTotals[p.id];

  return { perCategory, roundTotals };
}

function finalizeRound(room, answers, stoppedByPlayerId) {
  if (room.phase !== 'playing') return null;
  room.phase = 'results';

  const { perCategory, roundTotals } = scoreRound(room, answers);
  const stopper = room.players.find(p => p.id === stoppedByPlayerId);

  room.gameStats = room.gameStats || { stopCounts: {}, dupCounts: {} };
  if (stoppedByPlayerId) {
    room.gameStats.stopCounts[stoppedByPlayerId] = (room.gameStats.stopCounts[stoppedByPlayerId] || 0) + 1;
  }
  for (const cat of room.currentCategories) {
    for (const e of perCategory[cat]) {
      if (e.valid && e.points === 5) {
        room.gameStats.dupCounts[e.playerId] = (room.gameStats.dupCounts[e.playerId] || 0) + 1;
      }
    }
  }

  room.lastResults = { perCategory, roundTotals };
  room.activeChallenge = null;

  return {
    type: 'round_results',
    stoppedBy: stopper ? stopper.nickname : null,
    letter: room.letter,
    perCategory,
    roundTotals,
    leaderboard: buildLeaderboard(room),
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
  };
}

function resolveChallenge(room) {
  const ch = room.activeChallenge;
  if (!ch) return null;

  const votes = Object.values(ch.votes);
  const invalidos = votes.filter(v => v === false).length;
  const validos = votes.filter(v => v === true).length;
  const derrubado = invalidos > validos;

  if (derrubado) {
    const player = room.players.find(p => p.id === ch.targetPlayerId);
    if (player) player.score -= ch.entry.points;
    const entry = room.lastResults.perCategory[ch.category].find(e => e.playerId === ch.targetPlayerId);
    if (entry) entry.points = 0;
  }

  const event = {
    type: 'challenge_result',
    category: ch.category,
    targetPlayerId: ch.targetPlayerId,
    derrubado,
    votosValidos: validos,
    votosInvalidos: invalidos,
    leaderboard: buildLeaderboard(room),
  };

  room.activeChallenge = null;
  return event;
}

function checkForTieOrEnd(room) {
  const sorted = room.players.slice().sort((a, b) => b.score - a.score);
  const topScore = sorted.length ? sorted[0].score : 0;
  const tied = sorted.filter(p => p.score === topScore);

  if (tied.length > 1 && room.tiebreakEnabled && !room.tiebreakDone) {
    return startTiebreak(room, tied.map(p => p.id));
  }

  room.phase = 'podium';
  return [{ type: 'game_over', leaderboard: buildLeaderboard(room), stats: buildGameStats(room) }];
}

function startTiebreak(room, tiedIds) {
  room.phase = 'tiebreak';
  room.tiebreakPlayers = tiedIds;
  room.tiebreakLetter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  room.tiebreakCategory = CATEGORY_POOL[Math.floor(Math.random() * CATEGORY_POOL.length)];
  room.tiebreakAnswers = {};
  room.tiebreakDeadline = Date.now() + TIEBREAK_MS;

  return [{
    type: 'tiebreak_start',
    category: room.tiebreakCategory,
    letter: room.tiebreakLetter,
    playerIds: tiedIds,
    players: room.players.filter(p => tiedIds.includes(p.id)).map(p => p.nickname),
    maxMs: TIEBREAK_MS,
  }];
}

function resolveTiebreak(room) {
  const entries = room.tiebreakPlayers.map(id => {
    const p = room.players.find(pp => pp.id === id);
    const a = room.tiebreakAnswers[id];
    const val = ((a && a.value) || '').trim();
    const valid = val.length > 0 && val[0].toLocaleUpperCase('pt-BR') === room.tiebreakLetter;
    return {
      id,
      nickname: p ? p.nickname : 'Jogador',
      value: capitalizeFirst(val),
      valid,
      submittedAt: a ? a.submittedAt : Infinity,
    };
  });
  entries.sort((x, y) => {
    if (x.valid !== y.valid) return x.valid ? -1 : 1;
    return x.submittedAt - y.submittedAt;
  });

  room.tiebreakDone = true;
  room.tiebreakOrder = entries.map(e => e.id);

  const resultEvent = {
    type: 'tiebreak_result',
    category: room.tiebreakCategory,
    letter: room.tiebreakLetter,
    entries,
    winnerId: entries.length ? entries[0].id : null,
  };

  room.phase = 'podium';
  const gameOverEvent = { type: 'game_over', leaderboard: buildLeaderboard(room), stats: buildGameStats(room) };
  return [resultEvent, gameOverEvent];
}

function nextRoundOrEnd(room) {
  room.activeChallenge = null;
  if (room.currentRound >= room.totalRounds) {
    return checkForTieOrEnd(room);
  }
  room.currentRound += 1;
  return [startRound(room)];
}

module.exports = {
  CATEGORY_POOL, BAHIA_CATEGORY_POOL, CATEGORIES_PER_ROUND, MAX_PLAYERS,
  ROUND_MAX_MS, FREEZE_GRACE_MS, DEFAULT_VOTE_MS, VOTE_DURATION_OPTIONS,
  TIEBREAK_MS, LETTERS, ROOM_TTL_SECONDS,
  genCode, capitalizeFirst, pickRoundCategories, pickBahiaRoundNumbers, pickRandomCategories,
  buildGameStats, buildLeaderboard, roomPublicState, newRoom, startRound, scoreRound,
  finalizeRound, resolveChallenge, checkForTieOrEnd, startTiebreak, resolveTiebreak, nextRoundOrEnd,
};
