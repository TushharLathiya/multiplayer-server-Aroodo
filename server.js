const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// rooms[roomName] = { players: [], currentTurn: 0, gameActive: false, turnUsed: false, turnTimer: null }
const rooms = {};

function getOrCreateRoom(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      players: [],
      currentTurn: 0,
      gameActive: false,
      turnUsed: false,
      turnTimer: null
    };
  }
  return rooms[roomName];
}

function startTurn(roomName) {
  const room = rooms[roomName];
  if (!room || !room.gameActive) return;

  room.turnUsed = false;

  const playerName = room.players[room.currentTurn];
  console.log(`[${roomName}] Turn: ${playerName}`);

  io.to(roomName).emit("turnStart", { playerName });

  // Auto-advance after 10 seconds
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

  // Small delay then start first turn
  setTimeout(() => startTurn(roomName), 500);
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("joinRoom", (data) => {
    const { roomName, playerName } = data;
    if (!roomName || !playerName) return;

    const room = getOrCreateRoom(roomName);

    if (room.players.length >= 4) {
      socket.emit("roomFull");
      return;
    }

    socket.join(roomName);
    socket.roomName = roomName;
    socket.playerName = playerName;

    if (!room.players.includes(playerName)) {
      room.players.push(playerName);
    }

    socket.emit("joinedRoom", roomName);

    // Send updated player list to everyone
    io.to(roomName).emit("playerList", room.players);

    // Notify others
    socket.to(roomName).emit("playerJoined", playerName);

    console.log(`[${roomName}] ${playerName} joined. Players: ${room.players}`);

    // Start countdown when 4 players joined
    if (room.players.length === 4 && !room.gameActive) {
      console.log(`[${roomName}] 4 players! Starting countdown...`);
      io.to(roomName).emit("countdownStart");

      // Wait 4 seconds (3s countdown + 1s "Game Started!") then start game
      setTimeout(() => startGame(roomName), 4000);
    }
  });

  socket.on("temClick", () => {
    const roomName = socket.roomName;
    const playerName = socket.playerName;
    if (!roomName || !playerName) return;

    const room = rooms[roomName];
    if (!room || !room.gameActive) return;

    // Must be this player's turn
    if (room.players[room.currentTurn] !== playerName) return;

    // Can only click once per turn
    if (room.turnUsed) return;
    room.turnUsed = true;

    console.log(`[${roomName}] ${playerName} clicked TEM!`);
    io.to(roomName).emit("temClicked", playerName);

    // Advance to next turn after 1 second
    setTimeout(() => nextTurn(roomName), 1000);
  });

  socket.on("leaveRoom", () => {
    leaveRoom(socket);
  });

  socket.on("disconnect", () => {
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

  // If game was active and players dropped below 2, stop game
  if (room.gameActive && room.players.length < 2) {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.gameActive = false;
    console.log(`[${roomName}] Game stopped (not enough players)`);
  } else if (room.gameActive) {
    // Fix currentTurn index if it went out of bounds
    if (room.currentTurn >= room.players.length) {
      room.currentTurn = 0;
      startTurn(roomName);
    }
  }

  if (room.players.length === 0) {
    delete rooms[roomName];
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));