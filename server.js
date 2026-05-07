const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

const server = http.createServer(app);

const io = new Server(server);

const rooms = {};

io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    // CREATE OR JOIN ROOM
    socket.on("joinRoom", (data) => {

        const roomName = data.roomName;
        const playerName = data.playerName;

        if (!rooms[roomName]) {
            rooms[roomName] = [];
        }

        // MAX 4 PLAYERS
        if (rooms[roomName].length >= 4) {
            socket.emit("roomFull");
            return;
        }

        socket.join(roomName);

        socket.roomName = roomName;
        socket.playerName = playerName;

        rooms[roomName].push({
            id: socket.id,
            name: playerName
        });

        console.log(playerName + " joined " + roomName);

        // SEND PLAYER LIST
        const playerNames =
            rooms[roomName].map(p => p.name);

        io.to(roomName).emit(
            "playerList",
            playerNames
        );

        // SEND ROOM JOINED
        socket.emit(
            "joinedRoom",
            roomName
        );
    });

    // LEAVE ROOM
    socket.on("leaveRoom", () => {

        LeaveRoom(socket);
    });

    // DISCONNECT
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
        rooms[roomName] =
            rooms[roomName].filter(
                p => p.id !== socket.id
            );

        const playerNames =
            rooms[roomName].map(p => p.name);

        io.to(roomName).emit(
            "playerList",
            playerNames
        );

        console.log(socket.playerName + " left");

        if (rooms[roomName].length === 0) {
            delete rooms[roomName];

            console.log("Room Deleted");
        }
    }

    socket.roomName = null;
}

server.listen(3000, () => {

    console.log("Server Running On 3000");
});