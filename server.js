const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};

// NORMAL MATCHMAKING QUEUE
let matchQueue = [];
let matchTimer = null;
let matchTimerStart = null;

// COIN PARTY QUEUE (exactly 4 players)
let coinQueue = [];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── NORMAL MATCHMAKING ───────────────────────────────────────────
function broadcastQueueUpdate() {
  const playerCount = matchQueue.length;
  const timeLeft = matchTimerStart
    ? Math.max(0, Math.ceil((matchTimerStart + 10000 - Date.now()) / 1000))
    : 10;
  matchQueue.forEach(({ socketId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit("matchmakingUpdate", { playerCount, timeLeft });
  });
}

function startMatch() {
  if (matchQueue.length === 0) return;
  if (matchTimer) { clearTimeout(matchTimer); matchTimer = null; }
  matchTimerStart = null;

  if (matchQueue.length < 2) {
    const solo = matchQueue.splice(0, 1)[0];
    const s = io.sockets.sockets.get(solo.socketId);
    if (s) { s.inMatchmaking = false; s.emit("matchmakingFailed"); }
    console.log(`[Matchmaking] Only 1 player — match cancelled`);
    return;
  }

  const batch = matchQueue.splice(0, 4);
  let code = generateRoomCode();
  while (rooms[code]) code = generateRoomCode();

  const playerNames = batch.map(p => p.playerName);
  rooms[code] = { players: [...playerNames], currentTurn: 0, gameActive: false, turnTimer: null, maxPlayers: playerNames.length };

  batch.forEach(({ playerName, socketId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.join(code); s.roomName = code; s.playerName = playerName; s.inMatchmaking = false;
  });

  console.log(`[Matchmaking] Match started: ${code} with ${playerNames}`);
  io.to(code).emit("matchFound", code);
  io.to(code).emit("playerList", playerNames);
  io.to(code).emit("countdownStart");
  setTimeout(() => startGame(code), 4000);

  if (matchQueue.length > 0) {
    matchTimerStart = Date.now();
    broadcastQueueUpdate();
    matchTimer = setTimeout(startMatch, 10000);
  }
}

// ─── COIN PARTY ───────────────────────────────────────────────────
function broadcastCoinQueueUpdate() {
  coinQueue.forEach(({ socketId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit("coinMatchUpdate", { playerCount: coinQueue.length });
  });
}

function startCoinMatch() {
  if (coinQueue.length < 4) return;

  const batch = coinQueue.splice(0, 4);
  let code = generateRoomCode();
  while (rooms[code]) code = generateRoomCode();

  const playerNames = batch.map(p => p.playerName);
  rooms[code] = { players: [...playerNames], currentTurn: 0, gameActive: false, turnTimer: null, maxPlayers: 4 };

  batch.forEach(({ playerName, socketId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.join(code); s.roomName = code; s.playerName = playerName; s.inCoinMatch = false;
  });

  console.log(`[CoinParty] Match started: ${code} with ${playerNames}`);
  io.to(code).emit("coinMatchFound", code);
  io.to(code).emit("playerList", playerNames);
  io.to(code).emit("countdownStart");
  setTimeout(() => startGame(code), 4000);

  if (coinQueue.length > 0) broadcastCoinQueueUpdate();
}

// ─── GAME LOGIC ───────────────────────────────────────────────────
function startTurn(roomName) {
  const room = rooms[roomName];
  if (!room || !room.gameActive) return;
  const playerName = room.players[room.currentTurn];
  console.log(`[${roomName}] Turn: ${playerName}`);
  io.to(roomName).emit("turnStart", { playerName });
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => { console.log(`[${roomName}] Time up`); nextTurn(roomName); }, 10000);
}

function nextTurn(roomName) {
  const room = rooms[roomName];
  if (!room || !room.gameActive) return;
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.currentTurn = (room.currentTurn + 1) % room.players.length;
  startTurn(roomName);
}

function startGame(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  room.gameActive = true; room.currentTurn = 0;
  console.log(`[${roomName}] Game started!`);
  io.to(roomName).emit("gameStart");
  setTimeout(() => startTurn(roomName), 500);
}

// ─── CONNECTIONS ──────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("joinMatchmaking", (data) => {
    const { playerName } = data;
    if (!playerName) return;
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    matchQueue.push({ playerName, socketId: socket.id });
    socket.inMatchmaking = true;
    if (matchQueue.length === 1) { matchTimerStart = Date.now(); matchTimer = setTimeout(startMatch, 10000); }
    broadcastQueueUpdate();
    if (matchQueue.length >= 4) startMatch();
  });

  socket.on("leaveMatchmaking", () => {
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    socket.inMatchmaking = false;
    if (matchQueue.length === 0 && matchTimer) { clearTimeout(matchTimer); matchTimer = null; matchTimerStart = null; }
    else broadcastQueueUpdate();
  });

  socket.on("joinCoinMatch", (data) => {
    const { playerName } = data;
    if (!playerName) return;
    coinQueue = coinQueue.filter(p => p.socketId !== socket.id);
    coinQueue.push({ playerName, socketId: socket.id });
    socket.inCoinMatch = true;
    console.log(`[CoinParty] ${playerName} joined. Queue: ${coinQueue.length}/4`);
    broadcastCoinQueueUpdate();
    if (coinQueue.length >= 4) startCoinMatch();
  });

  socket.on("leaveCoinMatch", () => {
    coinQueue = coinQueue.filter(p => p.socketId !== socket.id);
    socket.inCoinMatch = false;
    broadcastCoinQueueUpdate();
  });

  socket.on("createRoom", (data) => {
    const { playerName, playerCount } = data;
    if (!playerName) return;
    const maxPlayers = (playerCount >= 2 && playerCount <= 4) ? playerCount : 2;
    let code = generateRoomCode();
    while (rooms[code]) code = generateRoomCode();
    rooms[code] = { players: [playerName], currentTurn: 0, gameActive: false, turnTimer: null, maxPlayers };
    socket.join(code); socket.roomName = code; socket.playerName = playerName;
    socket.emit("roomCreated", code);
    io.to(code).emit("playerList", rooms[code].players);
  });

  socket.on("joinRoom", (data) => {
    const { roomName, playerName } = data;
    if (!roomName || !playerName) return;
    const room = rooms[roomName];
    if (!room) { socket.emit("roomNotFound"); return; }
    if (room.players.length >= room.maxPlayers || room.gameActive) { socket.emit("roomFull"); return; }
    socket.join(roomName); socket.roomName = roomName; socket.playerName = playerName;
    if (!room.players.includes(playerName)) room.players.push(playerName);
    socket.emit("joinedRoom", roomName);
    io.to(roomName).emit("playerList", room.players);
    socket.to(roomName).emit("playerJoined", playerName);
    if (room.players.length === room.maxPlayers && !room.gameActive) {
      io.to(roomName).emit("countdownStart");
      setTimeout(() => startGame(roomName), 4000);
    }
  });

  socket.on("arrowClicked", (data) => {
    const roomName = socket.roomName;
    if (!roomName) return;
    const room = rooms[roomName];
    if (!room || !room.gameActive) return;
    if (room.players[room.currentTurn] !== socket.playerName) return;
    io.to(roomName).emit("arrowClicked", { arrowIndex: data.arrowIndex });
  });

  socket.on("turnDone", () => {
    const roomName = socket.roomName;
    const playerName = socket.playerName;
    if (!roomName || !playerName) return;
    const room = rooms[roomName];
    if (!room || !room.gameActive) return;
    if (room.players[room.currentTurn] !== playerName) return;
    nextTurn(roomName);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => {
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    if (matchQueue.length === 0 && matchTimer) { clearTimeout(matchTimer); matchTimer = null; matchTimerStart = null; }
    else if (matchQueue.length > 0) broadcastQueueUpdate();

    coinQueue = coinQueue.filter(p => p.socketId !== socket.id);
    if (coinQueue.length > 0) broadcastCoinQueueUpdate();

    leaveRoom(socket);
    console.log("Disconnected:", socket.id);
  });
});

function leaveRoom(socket) {
  const roomName = socket.roomName;
  const playerName = socket.playerName;
  if (!roomName || !playerName) return;
  socket.leave(roomName); socket.roomName = null; socket.playerName = null;
  const room = rooms[roomName];
  if (!room) return;
  room.players = room.players.filter(p => p !== playerName);
  socket.to(roomName).emit("playerLeft", playerName);
  io.to(roomName).emit("playerList", room.players);
  if (room.gameActive && room.players.length < 1) { if (room.turnTimer) clearTimeout(room.turnTimer); room.gameActive = false; }
  else if (room.gameActive && room.currentTurn >= room.players.length) { room.currentTurn = 0; startTurn(roomName); }
  if (room.players.length === 0) delete rooms[roomName];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));