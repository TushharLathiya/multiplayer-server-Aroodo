const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};

// MATCHMAKING QUEUE
let matchQueue = [];       // { playerName, socketId }
let matchTimer = null;
let matchTimerStart = null;

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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

  // Take up to 4 players from the front of the queue
  const batch = matchQueue.splice(0, 4);

  let code = generateRoomCode();
  while (rooms[code]) code = generateRoomCode();

  const playerNames = batch.map(p => p.playerName);

  rooms[code] = {
    players: [...playerNames],
    currentTurn: 0,
    gameActive: false,
    turnTimer: null,
    maxPlayers: playerNames.length
  };

  batch.forEach(({ playerName, socketId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.join(code);
    s.roomName = code;
    s.playerName = playerName;
    s.inMatchmaking = false;
  });

  console.log(`[Matchmaking] Match started: ${code} with ${playerNames}`);

  io.to(code).emit("matchFound", code);
  io.to(code).emit("playerList", playerNames);

  setTimeout(() => startGame(code), 1000);

  // If more players remain in queue, restart timer for them
  if (matchQueue.length > 0) {
    matchTimerStart = Date.now();
    broadcastQueueUpdate();
    matchTimer = setTimeout(startMatch, 10000);
  }
}

function startTurn(roomName) {
  const room = rooms[roomName];
  if (!room || !room.gameActive) return;

  const playerName = room.players[room.currentTurn];
  console.log(`[${roomName}] Turn: ${playerName}`);
  io.to(roomName).emit("turnStart", { playerName });

  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    console.log(`[${roomName}] Time up for ${playerName}, next turn`);
    nextTurn(roomName);
  }, 10000);
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
  room.gameActive = true;
  room.currentTurn = 0;
  console.log(`[${roomName}] Game started!`);
  io.to(roomName).emit("gameStart");
  setTimeout(() => startTurn(roomName), 500);
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // JOIN MATCHMAKING
  socket.on("joinMatchmaking", (data) => {
    const { playerName } = data;
    if (!playerName) return;

    // Remove if already in queue
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);

    matchQueue.push({ playerName, socketId: socket.id });
    socket.inMatchmaking = true;
    console.log(`[Matchmaking] ${playerName} joined queue. Size: ${matchQueue.length}`);

    // Start 10s timer when first player joins
    if (matchQueue.length === 1) {
      matchTimerStart = Date.now();
      matchTimer = setTimeout(startMatch, 10000);
    }

    broadcastQueueUpdate();

    // If 4 players ready, start immediately
    if (matchQueue.length >= 4) {
      startMatch();
    }
  });

  // LEAVE MATCHMAKING
  socket.on("leaveMatchmaking", () => {
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    socket.inMatchmaking = false;
    console.log(`[Matchmaking] Player left queue. Size: ${matchQueue.length}`);

    if (matchQueue.length === 0 && matchTimer) {
      clearTimeout(matchTimer);
      matchTimer = null;
      matchTimerStart = null;
    } else {
      broadcastQueueUpdate();
    }
  });

  // CREATE ROOM — generates a random code, stores max player count
  socket.on("createRoom", (data) => {
    const { playerName, playerCount } = data;
    if (!playerName) return;

    const maxPlayers = (playerCount >= 2 && playerCount <= 4) ? playerCount : 2;

    let code = generateRoomCode();
    while (rooms[code]) code = generateRoomCode();

    rooms[code] = {
      players: [playerName],
      currentTurn: 0,
      gameActive: false,
      turnTimer: null,
      maxPlayers: maxPlayers
    };

    socket.join(code);
    socket.roomName = code;
    socket.playerName = playerName;

    console.log(`[${code}] Room created by ${playerName} (max ${maxPlayers} players)`);

    socket.emit("roomCreated", code);
    io.to(code).emit("playerList", rooms[code].players);
  });

  // JOIN ROOM — only joins if room exists and is not full
  socket.on("joinRoom", (data) => {
    const { roomName, playerName } = data;
    if (!roomName || !playerName) return;

    const room = rooms[roomName];

    if (!room) { socket.emit("roomNotFound"); return; }

    if (room.players.length >= room.maxPlayers || room.gameActive) {
      socket.emit("roomFull"); return;
    }

    socket.join(roomName);
    socket.roomName = roomName;
    socket.playerName = playerName;

    if (!room.players.includes(playerName)) room.players.push(playerName);

    socket.emit("joinedRoom", roomName);
    io.to(roomName).emit("playerList", room.players);
    socket.to(roomName).emit("playerJoined", playerName);
    console.log(`[${roomName}] ${playerName} joined. Players: ${room.players} / ${room.maxPlayers}`);

    if (room.players.length === room.maxPlayers && !room.gameActive) {
      console.log(`[${roomName}] ${room.maxPlayers} players ready! Starting countdown...`);
      io.to(roomName).emit("countdownStart");
      setTimeout(() => startGame(roomName), 4000);
    }
  });

  // ARROW CLICKED
  socket.on("arrowClicked", (data) => {
    const roomName = socket.roomName;
    if (!roomName) return;
    const room = rooms[roomName];
    if (!room || !room.gameActive) return;
    if (room.players[room.currentTurn] !== socket.playerName) return;
    io.to(roomName).emit("arrowClicked", { arrowIndex: data.arrowIndex });
  });

  // TURN DONE
  socket.on("turnDone", () => {
    const roomName = socket.roomName;
    const playerName = socket.playerName;
    if (!roomName || !playerName) return;
    const room = rooms[roomName];
    if (!room || !room.gameActive) return;
    if (room.players[room.currentTurn] !== playerName) return;
    console.log(`[${roomName}] ${playerName} done — next turn`);
    nextTurn(roomName);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => {
    // Remove from matchmaking queue if waiting
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    if (matchQueue.length === 0 && matchTimer) {
      clearTimeout(matchTimer); matchTimer = null; matchTimerStart = null;
    } else if (matchQueue.length > 0) {
      broadcastQueueUpdate();
    }

    leaveRoom(socket);
    console.log("Disconnected:", socket.id);
  });
});

function leaveRoom(socket) {
  const roomName = socket.roomName;
  const playerName = socket.playerName;
  if (!roomName || !playerName) return;

  socket.leave(roomName);
  socket.roomName = null;
  socket.playerName = null;

  const room = rooms[roomName];
  if (!room) return;

  room.players = room.players.filter(p => p !== playerName);
  console.log(`[${roomName}] ${playerName} left. Players: ${room.players}`);

  socket.to(roomName).emit("playerLeft", playerName);
  io.to(roomName).emit("playerList", room.players);

  if (room.gameActive && room.players.length < 1) {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.gameActive = false;
    console.log(`[${roomName}] Game stopped`);
  } else if (room.gameActive && room.currentTurn >= room.players.length) {
    room.currentTurn = 0;
    startTurn(roomName);
  }

  if (room.players.length === 0) delete rooms[roomName];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));