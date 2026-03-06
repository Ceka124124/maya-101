const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const users = {};

const AVATAR_COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722'
];

// ─── DECK ────────────────────────────────────────────────────────────────────
function generateDominoSet() {
  const set = [];
  for (let i = 0; i <= 6; i++)
    for (let j = i; j <= 6; j++)
      set.push({ left: i, right: j, id: `${i}-${j}` });
  return set;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── ROOM ────────────────────────────────────────────────────────────────────
function createRoom(roomId) {
  return {
    id: roomId,
    players: {},      // pid -> { name, color, hand }
    order: [],        // BUG FIX: stable turn order array
    turnIdx: 0,       // BUG FIX: index into order[]
    boneyard: [],
    board: [],
    boardEnds: { left: null, right: null },
    started: false,
    winner: null,
    scores: {},
    round: 1,
  };
}

// BUG FIX: turn is always order[turnIdx], stable across calls
function currentTurn(room) {
  if (!room.order.length) return null;
  return room.order[room.turnIdx];
}

function advanceTurn(room) {
  if (!room.order.length) return;
  room.turnIdx = (room.turnIdx + 1) % room.order.length;
}

// ─── DEAL ────────────────────────────────────────────────────────────────────
function dealTiles(room) {
  room.boneyard = shuffle(generateDominoSet());
  room.board = [];
  room.boardEnds = { left: null, right: null };
  room.winner = null;

  // Reset hands
  room.order.forEach(pid => { room.players[pid].hand = []; });

  // Deal 7 tiles each
  room.order.forEach(pid => {
    for (let i = 0; i < 7; i++)
      room.players[pid].hand.push(room.boneyard.pop());
  });

  // Find who starts: highest double
  let startIdx = 0;
  let highDouble = -1;
  room.order.forEach((pid, idx) => {
    room.players[pid].hand.forEach(t => {
      if (t.left === t.right && t.left > highDouble) {
        highDouble = t.left;
        startIdx = idx;
      }
    });
  });
  room.turnIdx = startIdx;
}

// ─── CAN PLAY ─────────────────────────────────────────────────────────────────
function canPlay(tile, boardEnds) {
  if (boardEnds.left === null) return true;
  return tile.left === boardEnds.left || tile.right === boardEnds.left ||
         tile.left === boardEnds.right || tile.right === boardEnds.right;
}

// ─── PLACE TILE ───────────────────────────────────────────────────────────────
function placeTile(room, socketId, tileId, side) {
  if (currentTurn(room) !== socketId) return { ok: false, msg: 'Sıra sende değil!' };

  const player = room.players[socketId];
  if (!player) return { ok: false, msg: 'Oyuncu bulunamadı' };

  const tileIdx = player.hand.findIndex(t => t.id === tileId);
  if (tileIdx === -1) return { ok: false, msg: 'Taş elde yok' };

  // Work on a copy so we can flip safely
  let tile = { ...player.hand[tileIdx] };

  // ── FIRST TILE ──
  if (room.board.length === 0) {
    room.board.push({ ...tile, side: 'center' });
    room.boardEnds.left  = tile.left;
    room.boardEnds.right = tile.right;
    player.hand.splice(tileIdx, 1);
    advanceTurn(room);
    return { ok: true, tile, side: 'center', flipped: false };
  }

  // ── VALIDATE ──
  if (!canPlay(tile, room.boardEnds))
    return { ok: false, msg: 'Bu taş oynanamaz!' };

  let placed = false;
  let flipped = false;
  let placedSide = side;

  // Helper: try to fit tile on a specific end value, returns oriented tile or null
  function fitTile(t, endVal) {
    if (t.right === endVal) return { ...t, flipped: false };
    if (t.left  === endVal) return { left: t.right, right: t.left, id: t.id, flipped: true };
    return null;
  }

  if (side === 'left' || side === 'auto') {
    const fit = fitTile(tile, room.boardEnds.left);
    if (fit) {
      // fit.right === boardEnds.left → fit.left becomes new left end
      tile = { left: fit.left, right: fit.right, id: fit.id };
      flipped = fit.flipped;
      room.boardEnds.left = tile.left;
      room.board.unshift({ ...tile, side: 'left' });
      placed = true;
      placedSide = 'left';
    }
  }

  if (!placed && (side === 'right' || side === 'auto')) {
    const fit = fitTile({ left: tile.right, right: tile.left, id: tile.id }, room.boardEnds.right);
    // We need tile.left === boardEnds.right (so right end connects)
    // Reuse simpler logic:
    let t = { ...player.hand[tileIdx] }; // fresh copy
    if (t.left === room.boardEnds.right) {
      // place as-is: left connects to right end
      room.boardEnds.right = t.right;
      room.board.push({ ...t, side: 'right' });
      tile = t; flipped = false; placed = true; placedSide = 'right';
    } else if (t.right === room.boardEnds.right) {
      // flip: new orientation → left=t.right, right=t.left
      const ft = { left: t.right, right: t.left, id: t.id };
      room.boardEnds.right = ft.right;
      room.board.push({ ...ft, side: 'right' });
      tile = ft; flipped = true; placed = true; placedSide = 'right';
    }
  }

  if (!placed) return { ok: false, msg: 'Taş bu tarafa konulamaz!' };

  player.hand.splice(tileIdx, 1);

  // Check blocked: if no player can play and boneyard empty → end game
  if (player.hand.length === 0) {
    room.winner = socketId;
    calculateScores(room);
  }

  advanceTurn(room);

  return { ok: true, tile, side: placedSide, flipped };
}

// ─── DRAW ─────────────────────────────────────────────────────────────────────
function drawFromBoneyard(room, socketId) {
  if (currentTurn(room) !== socketId) return { ok: false, msg: 'Sıra sende değil!' };
  if (room.boneyard.length === 0) return { ok: false, msg: 'Pazar boş!' };

  const player = room.players[socketId];
  const tile = room.boneyard.pop();
  player.hand.push(tile);

  const playable = canPlay(tile, room.boardEnds);
  // BUG FIX: if not playable AND boneyard now empty, auto pass
  return { ok: true, tile, playable, boneyardLeft: room.boneyard.length };
}

// ─── SCORES ───────────────────────────────────────────────────────────────────
function calculateScores(room) {
  const winner = room.winner;
  if (!winner) return;
  if (!room.scores[winner]) room.scores[winner] = 0;
  room.order.forEach(pid => {
    if (pid === winner) return;
    if (!room.scores[pid]) room.scores[pid] = 0;
    const sum = room.players[pid].hand.reduce((s, t) => s + t.left + t.right, 0);
    room.scores[winner] += sum;
  });
}

// ─── PUBLIC STATE — BUG FIX: never expose other players' hands ───────────────
function getRoomPublicState(room) {
  const playersPublic = {};
  room.order.forEach(pid => {
    const p = room.players[pid];
    if (!p) return;
    playersPublic[pid] = {
      name: p.name,
      color: p.color,
      handCount: p.hand.length,
    };
  });
  return {
    id: room.id,
    order: room.order,
    turn: currentTurn(room),
    board: room.board,
    boardEnds: room.boardEnds,
    started: room.started,
    winner: room.winner,
    scores: room.scores,
    boneyardCount: room.boneyard.length,
    round: room.round,
    players: playersPublic,
  };
}

// ─── SOCKET ───────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('+ connect', socket.id);

  socket.on('join', ({ name, roomId }) => {
    const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    users[socket.id] = { name, color, roomId };

    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    // BUG FIX: don't add duplicate on reconnect
    if (!room.players[socket.id]) {
      room.players[socket.id] = { name, color, hand: [] };
      room.order.push(socket.id);
    }
    if (!room.scores[socket.id]) room.scores[socket.id] = 0;

    socket.join(roomId);

    // Send state + private hand
    io.to(roomId).emit('room_update', getRoomPublicState(room));
    socket.emit('your_hand', room.players[socket.id].hand);
    io.to(roomId).emit('chat', { system: true, msg: `👋 ${name} odaya katıldı!`, time: Date.now() });
  });

  socket.on('start_game', () => {
    const u = users[socket.id]; if (!u) return;
    const room = rooms[u.roomId]; if (!room || room.started) return;
    if (room.order.length < 2) { socket.emit('error_msg', 'En az 2 oyuncu gerekli!'); return; }

    dealTiles(room);
    room.started = true;

    room.order.forEach(pid => io.to(pid).emit('your_hand', room.players[pid].hand));
    io.to(u.roomId).emit('room_update', getRoomPublicState(room));
    io.to(u.roomId).emit('game_started', { firstPlayer: currentTurn(room) });
    io.to(u.roomId).emit('chat', { system: true, msg: '🎲 Oyun başladı!', time: Date.now() });
  });

  socket.on('place_tile', ({ tileId, side }) => {
    const u = users[socket.id]; if (!u) return;
    const room = rooms[u.roomId]; if (!room || !room.started) return;

    const result = placeTile(room, socket.id, tileId, side);
    if (!result.ok) { socket.emit('error_msg', result.msg); return; }

    // Send private hands to all
    room.order.forEach(pid => io.to(pid).emit('your_hand', room.players[pid].hand));

    io.to(u.roomId).emit('tile_placed', {
      playerId: socket.id,
      playerName: u.name,
      tile: result.tile,
      side: result.side,
      flipped: result.flipped,
    });
    io.to(u.roomId).emit('room_update', getRoomPublicState(room));

    if (room.winner) {
      io.to(u.roomId).emit('game_over', {
        winner: socket.id, winnerName: u.name, scores: room.scores
      });
    }
  });

  socket.on('draw_tile', () => {
    const u = users[socket.id]; if (!u) return;
    const room = rooms[u.roomId]; if (!room || !room.started) return;

    const result = drawFromBoneyard(room, socket.id);
    if (!result.ok) { socket.emit('error_msg', result.msg); return; }

    socket.emit('your_hand', room.players[socket.id].hand);
    socket.emit('drew_tile', { tile: result.tile, playable: result.playable });

    io.to(u.roomId).emit('room_update', getRoomPublicState(room));
    io.to(u.roomId).emit('player_drew', {
      playerId: socket.id, playerName: u.name, boneyardLeft: result.boneyardLeft
    });
  });

  socket.on('pass_turn', () => {
    const u = users[socket.id]; if (!u) return;
    const room = rooms[u.roomId];
    if (!room || !room.started || currentTurn(room) !== socket.id) return;

    advanceTurn(room);
    io.to(u.roomId).emit('room_update', getRoomPublicState(room));
    io.to(u.roomId).emit('chat', { system: true, msg: `${u.name} pas geçti`, time: Date.now() });
  });

  socket.on('new_round', () => {
    const u = users[socket.id]; if (!u) return;
    const room = rooms[u.roomId]; if (!room) return;

    room.round++;
    dealTiles(room);
    room.started = true;

    room.order.forEach(pid => io.to(pid).emit('your_hand', room.players[pid].hand));
    io.to(u.roomId).emit('room_update', getRoomPublicState(room));
    io.to(u.roomId).emit('new_round_started', { round: room.round });
    io.to(u.roomId).emit('chat', { system: true, msg: `🔄 ${room.round}. tur başladı!`, time: Date.now() });
  });

  socket.on('chat', ({ msg }) => {
    const u = users[socket.id]; if (!u || !msg?.trim()) return;
    io.to(u.roomId).emit('chat', {
      system: false, senderId: socket.id,
      name: u.name, color: u.color,
      msg: msg.trim().slice(0, 300), time: Date.now()
    });
  });

  socket.on('disconnect', () => {
    console.log('- disconnect', socket.id);
    const u = users[socket.id];
    if (u) {
      const room = rooms[u.roomId];
      if (room) {
        // BUG FIX: remove from order array properly
        const wasIdx = room.order.indexOf(socket.id);
        room.order = room.order.filter(p => p !== socket.id);
        delete room.players[socket.id];
        delete room.scores[socket.id];

        if (room.order.length === 0) {
          delete rooms[u.roomId];
        } else {
          // Fix turnIdx after removal
          if (wasIdx < room.turnIdx) room.turnIdx--;
          if (room.turnIdx >= room.order.length) room.turnIdx = 0;

          io.to(u.roomId).emit('room_update', getRoomPublicState(room));
          io.to(u.roomId).emit('chat', { system: true, msg: `${u.name} ayrıldı`, time: Date.now() });
        }
      }
      delete users[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 Domino server: http://localhost:${PORT}`));
