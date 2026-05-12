const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

app.get("/", (req, res) => {
    res.send("Server Running");
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

const rooms = {};

io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    socket.on("joinRoom", (data) => {

        const roomName = data.roomName;
        const playerName = data.playerName;

        if (!rooms[roomName]) {
            rooms[roomName] = [];
        }

        if (rooms[roomName].length >= 4) {
            socket.emit("roomFull");
            return;
        }

        socket.join(roomName);
        socket.roomName = roomName;
        socket.playerName = playerName;

        rooms[roomName].push({ id: socket.id, name: playerName });

        console.log(playerName + " joined " + roomName);

        // SEND FULL PLAYER LIST TO EVERYONE IN ROOM
        const playerNames = rooms[roomName].map(p => p.name);
        io.to(roomName).emit("playerList", playerNames);

        // ✅ NEW: NOTIFY ALL OTHERS WHO JUST JOINED (triggers popup)
        socket.to(roomName).emit("playerJoined", playerName);

        socket.emit("joinedRoom", roomName);
    });

    socket.on("leaveRoom", () => {
        LeaveRoom(socket);
    });

    socket.on("disconnect", () => {
        LeaveRoom(socket);
        console.log("Disconnected");
    });
});

function LeaveRoom(socket) {
    const roomName = socket.roomName;
    if (!roomName) return;

    socket.leave(roomName);

    if (rooms[roomName]) {
        rooms[roomName] = rooms[roomName].filter(p => p.id !== socket.id);

        const playerNames = rooms[roomName].map(p => p.name);
        io.to(roomName).emit("playerList", playerNames);

        // ✅ NEW: NOTIFY ALL REMAINING PLAYERS WHO LEFT
        io.to(roomName).emit("playerLeft", socket.playerName);

        console.log(socket.playerName + " left");

        if (rooms[roomName].length === 0) {
            delete rooms[roomName];
            console.log("Room Deleted");
        }
    }

    socket.roomName = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("Server Running On Port " + PORT);
});