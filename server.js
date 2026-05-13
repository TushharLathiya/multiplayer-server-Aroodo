const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.get("/", (req, res) => res.send("Server Running"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};

io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    socket.on("joinRoom", (data) => {

        const roomName = data.roomName;
        const playerName = data.playerName;

        if (!rooms[roomName]) {
            rooms[roomName] = {
                players: [],
                currentTurn: 0,
                gameActive: false,
                turnUsed: false,
                turnTimer: null
            };
        }

        if (rooms[roomName].players.length >= 4) {
            socket.emit("roomFull");
            return;
        }

        socket.join(roomName);
        socket.roomName = roomName;
        socket.playerName = playerName;

        rooms[roomName].players.push({ id: socket.id, name: playerName });

        console.log(playerName + " joined " + roomName);

        const playerNames = rooms[roomName].players.map(p => p.name);
        io.to(roomName).emit("playerList", playerNames);
        io.to(roomName).emit("playerJoined", playerName);
        socket.emit("joinedRoom", roomName);

        // START 3s COUNTDOWN WHEN 4 PLAYERS JOIN
        if (rooms[roomName].players.length === 4) {
            io.to(roomName).emit("countdownStart");
            setTimeout(() => startGame(roomName), 3000);
        }
    });

    // TEM BUTTON CLICKED
    socket.on("temClick", () => {
        const roomName = socket.roomName;
        if (!roomName || !rooms[roomName] || !rooms[roomName].gameActive) return;

        const currentPlayer = rooms[roomName].players[rooms[roomName].currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;
        if (rooms[roomName].turnUsed) return;

        rooms[roomName].turnUsed = true;
        io.to(roomName).emit("temClicked", socket.playerName);

        // Go to next turn after 1s
        clearTimeout(rooms[roomName].turnTimer);
        rooms[roomName].turnTimer = setTimeout(() => nextTurn(roomName), 1000);
    });

    socket.on("leaveRoom", () => LeaveRoom(socket));

    socket.on("disconnect", () => {
        LeaveRoom(socket);
        console.log("Disconnected");
    });
});

function startGame(roomName) {
    if (!rooms[roomName]) return;
    rooms[roomName].currentTurn = 0;
    rooms[roomName].gameActive = true;
    io.to(roomName).emit("gameStart");
    startTurn(roomName);
}

function startTurn(roomName) {
    if (!rooms[roomName] || !rooms[roomName].gameActive) return;

    const player = rooms[roomName].players[rooms[roomName].currentTurn];
    if (!player) return;

    rooms[roomName].turnUsed = false;

    io.to(roomName).emit("turnStart", { playerName: player.name });

    if (rooms[roomName].turnTimer) clearTimeout(rooms[roomName].turnTimer);

    // Auto next turn after 10s if player doesn't click
    rooms[roomName].turnTimer = setTimeout(() => nextTurn(roomName), 10000);
}

function nextTurn(roomName) {
    if (!rooms[roomName]) return;
    const count = rooms[roomName].players.length;
    if (count === 0) return;
    rooms[roomName].currentTurn = (rooms[roomName].currentTurn + 1) % count;
    startTurn(roomName);
}

function LeaveRoom(socket) {
    const roomName = socket.roomName;
    if (!roomName) return;

    socket.leave(roomName);

    if (rooms[roomName]) {
        rooms[roomName].players = rooms[roomName].players.filter(p => p.id !== socket.id);

        const playerNames = rooms[roomName].players.map(p => p.name);
        io.to(roomName).emit("playerList", playerNames);
        io.to(roomName).emit("playerLeft", socket.playerName);

        console.log(socket.playerName + " left");

        if (rooms[roomName].players.length === 0) {
            if (rooms[roomName].turnTimer) clearTimeout(rooms[roomName].turnTimer);
            delete rooms[roomName];
            console.log("Room Deleted");
        }
    }

    socket.roomName = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server Running On Port " + PORT));