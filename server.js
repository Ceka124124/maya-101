const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}, users = {};
const COLORS = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722'];

/* ─── Domino seti ─── */
function genSet() {
  const s = [];
  for (let i = 0; i <= 6; i++)
    for (let j = i; j <= 6; j++)
      s.push({ left: i, right: j, id: `${i}-${j}` });
  return s;
}

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/* ─── Oda ─── */
function mkRoom(id) {
  return {
    id, players: {}, order: [], turnIdx: 0,
    boneyard: [], board: [], ends: { left: null, right: null },
    started: false, winner: null, scores: {},
    round: 1,
    music: { url: null, playing: false, startedAt: null, pausedAt: 0 }
  };
}

function curTurn(r) { return r.order[r.turnIdx] || null; }

function nextTurn(r) {
  if (r.order.length === 0) return;
  r.turnIdx = (r.turnIdx + 1) % r.order.length;
}

/* ─── Dağıtım ─── */
function deal(r) {
  r.boneyard = shuffle(genSet());
  r.board    = [];
  r.ends     = { left: null, right: null };
  r.winner   = null;

  // Elleri sıfırla
  r.order.forEach(p => { r.players[p].hand = []; });

  // 7'şer taş dağıt
  r.order.forEach(p => {
    for (let i = 0; i < 7; i++) r.players[p].hand.push(r.boneyard.pop());
  });

  // En büyük doublea sahip oyuncu başlar
  let startIdx = 0, bestDouble = -1;
  r.order.forEach((p, i) => {
    r.players[p].hand.forEach(t => {
      if (t.left === t.right && t.left > bestDouble) {
        bestDouble = t.left;
        startIdx   = i;
      }
    });
  });
  r.turnIdx = startIdx;
}

/* ─── Oynanabilirlik ─── */
function canPlay(tile, ends) {
  if (ends.left === null) return true;
  return tile.left  === ends.left  || tile.right === ends.left ||
         tile.left  === ends.right || tile.right === ends.right;
}

/* ─── Taş yerleştirme ─── */
function place(r, pid, tileId, side) {
  if (curTurn(r) !== pid)
    return { ok: false, msg: 'Sıra sende değil!' };

  const pl = r.players[pid];
  if (!pl) return { ok: false, msg: 'Oyuncu bulunamadı' };

  const ti = pl.hand.findIndex(t => t.id === tileId);
  if (ti === -1) return { ok: false, msg: 'Taş elde yok' };

  // Orijinal taşı kopyala — artık hiçbir yerde pl.hand[ti] tekrar okunmayacak
  const orig = { ...pl.hand[ti] };

  /* ── İlk taş (board boş) ── */
  if (r.board.length === 0) {
    const placed = { ...orig, side: 'center' };
    r.board.push(placed);
    r.ends.left  = orig.left;
    r.ends.right = orig.right;
    pl.hand.splice(ti, 1);
    if (pl.hand.length === 0) { r.winner = pid; calcScores(r); }
    nextTurn(r);
    return { ok: true, tile: placed, side: 'center' };
  }

  if (!canPlay(orig, r.ends))
    return { ok: false, msg: 'Bu taş oynanamaz!' };

  /* ── Sol tarafa yerleştirme ── */
  function tryLeft() {
    const ev = r.ends.left;
    if (orig.right === ev) {
      // taş: [orig.left | orig.right=ev] → sola: orig.left açıkta kalır
      const t = { left: orig.left, right: orig.right, id: orig.id, side: 'left' };
      r.board.unshift(t);
      r.ends.left = t.left;
      return t;
    }
    if (orig.left === ev) {
      // ters çevir: [orig.right | orig.left=ev] → sola: orig.right açıkta kalır
      const t = { left: orig.right, right: orig.left, id: orig.id, side: 'left' };
      r.board.unshift(t);
      r.ends.left = t.left;
      return t;
    }
    return null;
  }

  /* ── Sağ tarafa yerleştirme ── */
  function tryRight() {
    const ev = r.ends.right;
    if (orig.left === ev) {
      // taş: [orig.left=ev | orig.right] → sağa: orig.right açıkta kalır
      const t = { left: orig.left, right: orig.right, id: orig.id, side: 'right' };
      r.board.push(t);
      r.ends.right = t.right;
      return t;
    }
    if (orig.right === ev) {
      // ters çevir: [orig.right=ev | orig.left] → sağa: orig.left açıkta kalır
      const t = { left: orig.right, right: orig.left, id: orig.id, side: 'right' };
      r.board.push(t);
      r.ends.right = t.right;
      return t;
    }
    return null;
  }

  let finalTile = null;
  let placedSide = side;

  if (side === 'left') {
    finalTile = tryLeft();
    if (!finalTile) return { ok: false, msg: 'Sol uca konulamaz!' };
  } else if (side === 'right') {
    finalTile = tryRight();
    if (!finalTile) return { ok: false, msg: 'Sağ uca konulamaz!' };
  } else {
    // auto: önce sol dene, olmazsa sağ
    finalTile = tryLeft();
    if (finalTile) {
      placedSide = 'left';
    } else {
      finalTile = tryRight();
      if (finalTile) placedSide = 'right';
    }
    if (!finalTile) return { ok: false, msg: 'Taş hiçbir yere konulamaz!' };
  }

  pl.hand.splice(ti, 1);
  if (pl.hand.length === 0) { r.winner = pid; calcScores(r); }
  nextTurn(r);
  return { ok: true, tile: finalTile, side: placedSide };
}

/* ─── Pazardan çekme ─── */
function drawBone(r, pid) {
  if (curTurn(r) !== pid) return { ok: false, msg: 'Sıra sende değil!' };
  if (!r.boneyard.length)  return { ok: false, msg: 'Pazar boş!' };
  const t = r.boneyard.pop();
  r.players[pid].hand.push(t);
  return { ok: true, tile: t, playable: canPlay(t, r.ends), left: r.boneyard.length };
}

/* ─── Skor hesaplama ─── */
function calcScores(r) {
  if (!r.winner) return;
  if (!r.scores[r.winner]) r.scores[r.winner] = 0;
  r.order.forEach(p => {
    if (p === r.winner) return;
    if (!r.scores[p]) r.scores[p] = 0;
    const pts = r.players[p].hand.reduce((a, t) => a + t.left + t.right, 0);
    r.scores[r.winner] += pts;
  });
}

/* ─── Herkese görünen oda durumu ─── */
function pubState(r) {
  const ps = {};
  r.order.forEach(p => {
    const pl = r.players[p];
    if (pl) ps[p] = { name: pl.name, color: pl.color, handCount: pl.hand.length };
  });
  return {
    id: r.id, order: r.order, turn: curTurn(r),
    board: r.board, ends: r.ends,
    started: r.started, winner: r.winner,
    scores: r.scores, boneyardCount: r.boneyard.length,
    round: r.round, players: ps
  };
}

/* ─── Herkese el gönder ─── */
function broadcastHands(r) {
  r.order.forEach(p => {
    const pl = r.players[p];
    if (pl) io.to(p).emit('your_hand', pl.hand.map(t => ({ ...t })));
  });
}

/* ════════════════ SOCKET ════════════════ */
io.on('connection', socket => {

  socket.on('join', ({ name, roomId }) => {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    users[socket.id] = { name, color, roomId };

    if (!rooms[roomId]) rooms[roomId] = mkRoom(roomId);
    const r = rooms[roomId];

    if (!r.players[socket.id]) {
      r.players[socket.id] = { name, color, hand: [] };
      r.order.push(socket.id);
    }
    if (!r.scores[socket.id]) r.scores[socket.id] = 0;

    socket.join(roomId);
    socket.emit('your_hand', r.players[socket.id].hand.map(t => ({ ...t })));
    io.to(roomId).emit('room_update', pubState(r));
    if (r.music.url) socket.emit('music_state', r.music);
    io.to(roomId).emit('chat', { system: true, msg: `👋 ${name} katıldı!`, time: Date.now() });
  });

  socket.on('start_game', () => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r || r.started) return;
    if (r.order.length < 2) { socket.emit('error_msg', 'En az 2 oyuncu gerekli!'); return; }

    deal(r);
    r.started = true;
    broadcastHands(r);
    io.to(u.roomId).emit('room_update', pubState(r));
    io.to(u.roomId).emit('game_started', { firstPlayer: curTurn(r) });
    io.to(u.roomId).emit('chat', { system: true, msg: '🎲 Oyun başladı!', time: Date.now() });
  });

  socket.on('place_tile', ({ tileId, side }) => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r || !r.started) return;

    const res = place(r, socket.id, tileId, side);
    if (!res.ok) { socket.emit('error_msg', res.msg); return; }

    // Önce tüm elleri gönder
    broadcastHands(r);
    // Sonra board/state güncelle
    io.to(u.roomId).emit('tile_placed', {
      playerId: socket.id, playerName: u.name,
      tile: res.tile, side: res.side
    });
    io.to(u.roomId).emit('room_update', pubState(r));
    if (r.winner) {
      io.to(u.roomId).emit('game_over', {
        winner: socket.id, winnerName: u.name, scores: r.scores
      });
    }
  });

  socket.on('draw_tile', () => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r || !r.started) return;

    const res = drawBone(r, socket.id);
    if (!res.ok) { socket.emit('error_msg', res.msg); return; }

    socket.emit('your_hand', r.players[socket.id].hand.map(t => ({ ...t })));
    socket.emit('drew_tile', { tile: { ...res.tile }, playable: res.playable });
    io.to(u.roomId).emit('room_update', pubState(r));
    io.to(u.roomId).emit('player_drew', { playerId: socket.id, playerName: u.name });
  });

  socket.on('pass_turn', () => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];
    if (!r || !r.started || curTurn(r) !== socket.id) return;
    nextTurn(r);
    io.to(u.roomId).emit('room_update', pubState(r));
    io.to(u.roomId).emit('chat', { system: true, msg: `${u.name} pas geçti`, time: Date.now() });
  });

  socket.on('new_round', () => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r) return;
    r.round++;
    deal(r);
    r.started = true;
    broadcastHands(r);
    io.to(u.roomId).emit('room_update', pubState(r));
    io.to(u.roomId).emit('new_round_started', { round: r.round });
  });

  socket.on('chat', ({ msg }) => {
    const u = users[socket.id]; if (!u || !msg?.trim()) return;
    io.to(u.roomId).emit('chat', {
      system: false, senderId: socket.id,
      name: u.name, color: u.color,
      msg: msg.trim().slice(0, 300), time: Date.now()
    });
  });

  socket.on('emoji_react', ({ emoji }) => {
    const u = users[socket.id]; if (!u) return;
    io.to(u.roomId).emit('emoji_react', {
      senderId: socket.id, name: u.name, color: u.color, emoji
    });
  });

  socket.on('music_set', ({ url }) => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r) return;
    r.music = { url, playing: false, startedAt: null, pausedAt: 0 };
    io.to(u.roomId).emit('music_state', r.music);
  });

  socket.on('music_play', ({ position }) => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r) return;
    r.music.playing   = true;
    r.music.startedAt = Date.now() - (position || 0) * 1000;
    r.music.pausedAt  = position || 0;
    io.to(u.roomId).emit('music_state', r.music);
  });

  socket.on('music_pause', ({ position }) => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r) return;
    r.music.playing  = false;
    r.music.pausedAt = position || 0;
    io.to(u.roomId).emit('music_state', r.music);
  });

  socket.on('music_seek', ({ position }) => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];  if (!r) return;
    r.music.pausedAt = position;
    if (r.music.playing) r.music.startedAt = Date.now() - position * 1000;
    io.to(u.roomId).emit('music_state', r.music);
  });

  socket.on('disconnect', () => {
    const u = users[socket.id]; if (!u) return;
    const r = rooms[u.roomId];
    if (r) {
      const wi = r.order.indexOf(socket.id);
      r.order   = r.order.filter(p => p !== socket.id);
      delete r.players[socket.id];
      delete r.scores[socket.id];

      if (!r.order.length) {
        delete rooms[u.roomId];
      } else {
        // turnIdx'i düzelt
        if (wi <= r.turnIdx) r.turnIdx = Math.max(0, r.turnIdx - 1);
        if (r.turnIdx >= r.order.length) r.turnIdx = 0;
        io.to(u.roomId).emit('room_update', pubState(r));
        io.to(u.roomId).emit('chat', { system: true, msg: `${u.name} ayrıldı`, time: Date.now() });
      }
    }
    delete users[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 Domino → http://localhost:${PORT}`));
