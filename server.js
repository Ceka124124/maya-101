const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY STATE ────────────────────────────────────────────────────────
const rooms = {}; // roomId -> roomState
const users = {}; // socketId -> { name, color, roomId }

const AVATAR_COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722'
];

// ─── DOMINO HELPERS ─────────────────────────────────────────────────────────
function generateDominoSet() {
  const set = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      set.push({ left: i, right: j, id: `${i}-${j}` });
    }
  }
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

function createRoom(roomId) {
  const allTiles = shuffle(generateDominoSet());
  const boneyard = [...allTiles];
  const players = {};
  return {
    id: roomId,
    players,
    boneyard,
    board: [],
    boardEnds: { left: null, right: null },
    turn: null,
    started: false,
    winner: null,
    scores: {},
    round: 1,
    chat: []
  };
}

function dealTiles(room) {
  const playerIds = Object.keys(room.players);
  room.boneyard = shuffle(generateDominoSet());
  playerIds.forEach(pid => { room.players[pid].hand = []; });
  playerIds.forEach(pid => {
    for (let i = 0; i < 7; i++) {
      room.players[pid].hand.push(room.boneyard.pop());
    }
  });
  // Find who has double-6 or highest double
  let startPlayer = playerIds[0];
  let highDouble = -1;
  playerIds.forEach(pid => {
    room.players[pid].hand.forEach(t => {
      if (t.left === t.right && t.left > highDouble) {
        highDouble = t.left;
        startPlayer = pid;
      }
    });
  });
  room.turn = startPlayer;
  room.board = [];
  room.boardEnds = { left: null, right: null };
  room.winner = null;
}

function canPlay(tile, boardEnds) {
  if (boardEnds.left === null) return true;
  return tile.left === boardEnds.left || tile.right === boardEnds.left ||
         tile.left === boardEnds.right || tile.right === boardEnds.right;
}

function placeTile(room, socketId, tileId, side) {
  const player = room.players[socketId];
  if (!player) return { ok: false, msg: 'Player not found' };
  if (room.turn !== socketId) return { ok: false, msg: 'Not your turn' };

  const tileIdx = player.hand.findIndex(t => t.id === tileId);
  if (tileIdx === -1) return { ok: false, msg: 'Tile not in hand' };

  const tile = { ...player.hand[tileIdx] };

  // First tile
  if (room.board.length === 0) {
    room.board.push({ ...tile, side: 'center', x: 0 });
    room.boardEnds.left = tile.left;
    room.boardEnds.right = tile.right;
    player.hand.splice(tileIdx, 1);
    advanceTurn(room);
    return { ok: true, tile, side: 'center' };
  }

  // Determine placement
  let placed = false;
  let flipped = false;

  if (side === 'left') {
    if (tile.right === room.boardEnds.left) {
      room.boardEnds.left = tile.left;
      room.board.unshift({ ...tile, side: 'left' });
      placed = true;
    } else if (tile.left === room.boardEnds.left) {
      // flip tile
      [tile.left, tile.right] = [tile.right, tile.left];
      flipped = true;
      room.boardEnds.left = tile.left;
      room.board.unshift({ ...tile, side: 'left' });
      placed = true;
    }
  } else if (side === 'right') {
    if (tile.left === room.boardEnds.right) {
      room.boardEnds.right = tile.right;
      room.board.push({ ...tile, side: 'right' });
      placed = true;
    } else if (tile.right === room.boardEnds.right) {
      [tile.left, tile.right] = [tile.right, tile.left];
      flipped = true;
      room.boardEnds.right = tile.right;
      room.board.push({ ...tile, side: 'right' });
      placed = true;
    }
  } else {
    // auto side
    if (tile.left === room.boardEnds.right || tile.right === room.boardEnds.right) {
      if (tile.right === room.boardEnds.right) { /* ok */ }
      else { [tile.left, tile.right] = [tile.right, tile.left]; flipped = true; }
      room.boardEnds.right = tile.right;
      room.board.push({ ...tile, side: 'right' });
      placed = true;
    } else if (tile.left === room.boardEnds.left || tile.right === room.boardEnds.left) {
      if (tile.right === room.boardEnds.left) { /* ok */ }
      else { [tile.left, tile.right] = [tile.right, tile.left]; flipped = true; }
      room.boardEnds.left = tile.left;
      room.board.unshift({ ...tile, side: 'left' });
      placed = true;
    }
  }

  if (!placed) return { ok: false, msg: 'Cannot place tile here' };

  player.hand.splice(tileIdx, 1);
  advanceTurn(room);

  // Check win
  if (player.hand.length === 0) {
    room.winner = socketId;
    calculateScores(room);
  }

  return { ok: true, tile, side, flipped };
}

function drawFromBoneyard(room, socketId) {
  if (room.turn !== socketId) return { ok: false, msg: 'Not your turn' };
  if (room.boneyard.length === 0) return { ok: false, msg: 'Boneyard empty' };
  const player = room.players[socketId];

  // Draw ONE tile at a time, check if playable
  const tile = room.boneyard.pop();
  player.hand.push(tile);

  const playable = canPlay(tile, room.boardEnds);
  return { ok: true, tile, playable, boneyardLeft: room.boneyard.length };
}

function advanceTurn(room) {
  const ids = Object.keys(room.players);
  const idx = ids.indexOf(room.turn);
  room.turn = ids[(idx + 1) % ids.length];
}

function calculateScores(room) {
  Object.keys(room.players).forEach(pid => {
    const handSum = room.players[pid].hand.reduce((s, t) => s + t.left + t.right, 0);
    if (!room.scores[pid]) room.scores[pid] = 0;
    if (pid === room.winner) {
      // Winner gets sum of all others' hands
      Object.keys(room.players).forEach(other => {
        if (other !== pid) {
          const otherSum = room.players[other].hand.reduce((s, t) => s + t.left + t.right, 0);
          room.scores[pid] += otherSum;
        }
      });
    }
  });
}

function getRoomPublicState(room) {
  const playersPublic = {};
  Object.entries(room.players).forEach(([pid, p]) => {
    playersPublic[pid] = {
      name: p.name,
      color: p.color,
      handCount: p.hand.length,
      hand: p.hand // sent per-player privately
    };
  });
  return {
    id: room.id,
    board: room.board,
    boardEnds: room.boardEnds,
    turn: room.turn,
    started: room.started,
    winner: room.winner,
    scores: room.scores,
    boneyardCount: room.boneyard.length,
    round: room.round,
    players: playersPublic
  };
}

// ─── SOCKET LOGIC ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', ({ name, roomId }) => {
    const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    users[socket.id] = { name, color, roomId };

    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    room.players[socket.id] = { name, color, hand: [], ready: false };
    if (!room.scores[socket.id]) room.scores[socket.id] = 0;

    socket.join(roomId);

    io.to(roomId).emit('room_update', getRoomPublicState(room));
    io.to(roomId).emit('chat', {
      system: true,
      msg: `${name} odaya katıldı!`,
      time: Date.now()
    });

    // Send private hand
    socket.emit('your_hand', room.players[socket.id].hand);
  });

  socket.on('start_game', () => {
    const user = users[socket.id];
    if (!user) return;
    const room = rooms[user.roomId];
    if (!room || room.started) return;
    if (Object.keys(room.players).length < 2) {
      socket.emit('error_msg', 'En az 2 oyuncu gerekli!');
      return;
    }

    dealTiles(room);
    room.started = true;

    // Send private hands
    Object.keys(room.players).forEach(pid => {
      io.to(pid).emit('your_hand', room.players[pid].hand);
    });

    io.to(user.roomId).emit('room_update', getRoomPublicState(room));
    io.to(user.roomId).emit('game_started', { firstPlayer: room.turn });
    io.to(user.roomId).emit('chat', {
      system: true, msg: '🎮 Oyun başladı!', time: Date.now()
    });
  });

  socket.on('place_tile', ({ tileId, side }) => {
    const user = users[socket.id];
    if (!user) return;
    const room = rooms[user.roomId];
    if (!room || !room.started) return;

    const result = placeTile(room, socket.id, tileId, side);
    if (!result.ok) {
      socket.emit('error_msg', result.msg);
      return;
    }

    // Update hands
    Object.keys(room.players).forEach(pid => {
      io.to(pid).emit('your_hand', room.players[pid].hand);
    });

    io.to(user.roomId).emit('tile_placed', {
      playerId: socket.id,
      playerName: user.name,
      tile: result.tile,
      side: result.side,
      flipped: result.flipped
    });

    io.to(user.roomId).emit('room_update', getRoomPublicState(room));

    if (room.winner) {
      io.to(user.roomId).emit('game_over', {
        winner: socket.id,
        winnerName: user.name,
        scores: room.scores
      });
    }
  });

  socket.on('draw_tile', () => {
    const user = users[socket.id];
    if (!user) return;
    const room = rooms[user.roomId];
    if (!room || !room.started) return;

    const result = drawFromBoneyard(room, socket.id);
    if (!result.ok) {
      socket.emit('error_msg', result.msg);
      return;
    }

    socket.emit('your_hand', room.players[socket.id].hand);
    socket.emit('drew_tile', { tile: result.tile, playable: result.playable });

    io.to(user.roomId).emit('room_update', getRoomPublicState(room));
    io.to(user.roomId).emit('player_drew', {
      playerId: socket.id,
      playerName: user.name,
      boneyardLeft: result.boneyardLeft
    });
  });

  socket.on('pass_turn', () => {
    const user = users[socket.id];
    if (!user) return;
    const room = rooms[user.roomId];
    if (!room || !room.started || room.turn !== socket.id) return;

    advanceTurn(room);
    io.to(user.roomId).emit('room_update', getRoomPublicState(room));
    io.to(user.roomId).emit('chat', {
      system: true, msg: `${user.name} pas geçti`, time: Date.now()
    });
  });

  socket.on('new_round', () => {
    const user = users[socket.id];
    if (!user) return;
    const room = rooms[user.roomId];
    if (!room) return;

    room.round++;
    dealTiles(room);
    room.started = true;

    Object.keys(room.players).forEach(pid => {
      io.to(pid).emit('your_hand', room.players[pid].hand);
    });

    io.to(user.roomId).emit('room_update', getRoomPublicState(room));
    io.to(user.roomId).emit('new_round_started', { round: room.round });
    io.to(user.roomId).emit('chat', {
      system: true, msg: `🔄 ${room.round}. tur başladı!`, time: Date.now()
    });
  });

  socket.on('chat', ({ msg }) => {
    const user = users[socket.id];
    if (!user || !msg.trim()) return;
    io.to(user.roomId).emit('chat', {
      system: false,
      senderId: socket.id,
      name: user.name,
      color: user.color,
      msg: msg.trim().substring(0, 300),
      time: Date.now()
    });
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      const room = rooms[user.roomId];
      if (room) {
        delete room.players[socket.id];
        delete room.scores[socket.id];
        if (room.turn === socket.id) advanceTurn(room);
        if (Object.keys(room.players).length === 0) {
          delete rooms[user.roomId];
        } else {
          io.to(user.roomId).emit('room_update', getRoomPublicState(room));
          io.to(user.roomId).emit('chat', {
            system: true, msg: `${user.name} ayrıldı`, time: Date.now()
          });
        }
      }
      delete users[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 Domino server: http://localhost:${PORT}`));
