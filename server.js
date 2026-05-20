'use strict';

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer();
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ─── State ───────────────────────────────────────────────────────────────────
const rooms    = {};       // roomName → { players: [], maxPlayers, sockets: {} }
let matchQueue = [];       // free matchmaking queue
let coinQueue  = [];       // 4-player coin party queue
let coinQueue2 = [];       // 2-player coin party queue

let matchTimer  = null;
let matchTimeLeft = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function broadcastQueueUpdate() {
    matchQueue.forEach(s => s.emit('matchmakingUpdate', { playerCount: matchQueue.length, timeLeft: matchTimeLeft }));
}

function broadcastCoinQueueUpdate() {
    coinQueue.forEach(s => s.emit('coinMatchUpdate', { playerCount: coinQueue.length }));
}

function broadcastCoinQueue2Update() {
    coinQueue2.forEach(s => s.emit('coinMatch2Update', { playerCount: coinQueue2.length }));
}

function startMatch(sockets) {
    const code = makeRoomCode();
    const players = sockets.map(s => s.playerName);
    rooms[code] = { players: [...players], maxPlayers: players.length, sockets: {} };
    sockets.forEach(s => {
        s.join(code);
        s.currentRoom = code;
        rooms[code].sockets[s.playerName] = s;
        s.emit('matchFound', code);
    });
    io.to(code).emit('playerList', players);
    io.to(code).emit('countdownStart');
}

function startCoinMatch(sockets) {
    const code = makeRoomCode();
    const players = sockets.map(s => s.playerName);
    rooms[code] = { players: [...players], maxPlayers: players.length, sockets: {} };
    sockets.forEach(s => {
        s.join(code);
        s.currentRoom = code;
        rooms[code].sockets[s.playerName] = s;
        s.emit('coinMatchFound', code);
    });
    io.to(code).emit('playerList', players);
    io.to(code).emit('countdownStart');
}

function startCoinMatch2(sockets) {
    const code = makeRoomCode();
    const players = sockets.map(s => s.playerName);
    rooms[code] = { players: [...players], maxPlayers: players.length, sockets: {} };
    sockets.forEach(s => {
        s.join(code);
        s.currentRoom = code;
        rooms[code].sockets[s.playerName] = s;
        s.emit('coinMatch2Found', code);
    });
    io.to(code).emit('playerList', players);
    io.to(code).emit('countdownStart');
}

function leaveRoom(socket) {
    const room = socket.currentRoom;
    if (!room || !rooms[room]) return;

    const playerName = socket.playerName;
    rooms[room].players = rooms[room].players.filter(p => p !== playerName);
    delete rooms[room].sockets[playerName];
    socket.leave(room);
    socket.currentRoom = null;

    if (rooms[room].players.length === 0) {
        delete rooms[room];
    } else {
        io.to(room).emit('playerLeft', playerName);
        io.to(room).emit('playerList', rooms[room].players);
    }
}

// ─── Free matchmaking timer ───────────────────────────────────────────────────
function startMatchTimer() {
    if (matchTimer) return;
    matchTimeLeft = 10;
    matchTimer = setInterval(() => {
        matchTimeLeft--;
        broadcastQueueUpdate();
        if (matchTimeLeft <= 0) {
            clearInterval(matchTimer); matchTimer = null;
            if (matchQueue.length >= 2) {
                const group = matchQueue.splice(0, matchQueue.length);
                startMatch(group);
            } else if (matchQueue.length === 1) {
                const solo = matchQueue.splice(0, 1)[0];
                solo.emit('matchmakingFailed');
            }
        }
    }, 1000);
}

// ─── Socket connection ────────────────────────────────────────────────────────
io.on('connection', socket => {
    console.log('connected:', socket.id);

    // ── Create room ──────────────────────────────────────────────────────────
    socket.on('createRoom', ({ playerName, playerCount }) => {
        const code = makeRoomCode();
        socket.playerName = playerName;
        socket.currentRoom = code;
        const max = (playerCount >= 2 && playerCount <= 4) ? playerCount : 4;
        rooms[code] = { players: [playerName], maxPlayers: max, sockets: { [playerName]: socket } };
        socket.join(code);
        socket.emit('roomCreated', code);
        io.to(code).emit('playerList', rooms[code].players);
    });

    // ── Join room ────────────────────────────────────────────────────────────
    socket.on('joinRoom', ({ roomName, playerName }) => {
        const room = rooms[roomName];
        if (!room) { socket.emit('roomNotFound'); return; }
        if (room.players.length >= room.maxPlayers) { socket.emit('roomFull'); return; }

        socket.playerName = playerName;
        socket.currentRoom = roomName;
        room.players.push(playerName);
        room.sockets[playerName] = socket;
        socket.join(roomName);

        socket.emit('joinedRoom', roomName);
        io.to(roomName).emit('playerJoined', playerName);
        io.to(roomName).emit('playerList', room.players);

        if (room.players.length === room.maxPlayers)
            io.to(roomName).emit('countdownStart');
    });

    // ── Leave room ───────────────────────────────────────────────────────────
    socket.on('leaveRoom', () => leaveRoom(socket));

    // ── Game start ───────────────────────────────────────────────────────────
    socket.on('gameStart', () => {
        const room = socket.currentRoom;
        if (room) io.to(room).emit('gameStart');
    });

    // ── Turn done ─────────────────────────────────────────────────────────────
    socket.on('turnDone', () => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const players = rooms[room].players;
        if (players.length === 0) return;

        // Advance to next player round-robin
        const cur = rooms[room].currentTurnIndex ?? 0;
        const next = (cur + 1) % players.length;
        rooms[room].currentTurnIndex = next;
        io.to(room).emit('turnStart', { playerName: players[next] });
    });

    // ── countdownStart → server kicks off first turn after 4s ────────────────
    socket.on('readyForTurn', () => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        rooms[room].readyCount = (rooms[room].readyCount ?? 0) + 1;
        if (rooms[room].readyCount >= rooms[room].players.length) {
            rooms[room].currentTurnIndex = 0;
            io.to(room).emit('gameStart');
            setTimeout(() => {
                if (rooms[room]) io.to(room).emit('turnStart', { playerName: rooms[room].players[0] });
            }, 4000); // 3s countdown + 1s "Game Started!"
        }
    });

    // ── Arrow clicked ─────────────────────────────────────────────────────────
    socket.on('arrowClicked', ({ arrowIndex }) => {
        const room = socket.currentRoom;
        if (room) io.to(room).emit('arrowClicked', { arrowIndex });
    });

    // ── Free matchmaking ──────────────────────────────────────────────────────
    socket.on('joinMatchmaking', ({ playerName }) => {
        socket.playerName = playerName;
        if (!matchQueue.find(s => s.id === socket.id)) {
            matchQueue.push(socket);
        }
        broadcastQueueUpdate();
        startMatchTimer();
    });

    socket.on('leaveMatchmaking', () => {
        matchQueue = matchQueue.filter(s => s.id !== socket.id);
        if (matchQueue.length === 0 && matchTimer) {
            clearInterval(matchTimer); matchTimer = null;
        }
    });

    // ── Coin matchmaking (4P) ─────────────────────────────────────────────────
    socket.on('joinCoinMatch', ({ playerName }) => {
        socket.playerName = playerName;
        if (!coinQueue.find(s => s.id === socket.id)) coinQueue.push(socket);
        broadcastCoinQueueUpdate();
        if (coinQueue.length >= 4) {
            const group = coinQueue.splice(0, 4);
            startCoinMatch(group);
        }
    });

    socket.on('leaveCoinMatch', () => {
        coinQueue = coinQueue.filter(s => s.id !== socket.id);
        broadcastCoinQueueUpdate();
    });

    // ── Coin matchmaking (2P) ─────────────────────────────────────────────────
    socket.on('joinCoinMatch2', ({ playerName }) => {
        socket.playerName = playerName;
        if (!coinQueue2.find(s => s.id === socket.id)) coinQueue2.push(socket);
        broadcastCoinQueue2Update();
        if (coinQueue2.length >= 2) {
            const group = coinQueue2.splice(0, 2);
            startCoinMatch2(group);
        }
    });

    socket.on('leaveCoinMatch2', () => {
        coinQueue2 = coinQueue2.filter(s => s.id !== socket.id);
        broadcastCoinQueue2Update();
    });

    // ── Disconnect cleanup ────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log('disconnected:', socket.id);
        matchQueue  = matchQueue.filter(s => s.id !== socket.id);
        coinQueue   = coinQueue.filter(s => s.id !== socket.id);
        coinQueue2  = coinQueue2.filter(s => s.id !== socket.id);
        if (matchQueue.length === 0 && matchTimer) { clearInterval(matchTimer); matchTimer = null; }
        leaveRoom(socket);
    });
});

server.listen(PORT, () => console.log('Server listening on port ' + PORT));