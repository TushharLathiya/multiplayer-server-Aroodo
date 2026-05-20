'use strict';

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer();
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ─── State ────────────────────────────────────────────────────────────────────
const rooms     = {};
let matchQueue  = [];
let coinQueue   = [];   // 4P coin party
let coinQueue2  = [];   // 2P coin party

let matchTimer      = null;
let matchTimeLeft   = 10;
let coinQueueTimer  = null;
let coinQueue2Timer = null;

const COIN_WAIT_SECONDS = 30; // seconds before bots fill empty slots

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function isBot(name) {
    return typeof name === 'string' && name.startsWith('Bot ');
}

// Advance to next turn; auto-plays if next player is a bot
function advanceTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    const next = ((room.currentTurnIndex ?? 0) + 1) % room.players.length;
    room.currentTurnIndex = next;
    const nextPlayer = room.players[next];

    io.to(roomCode).emit('turnStart', { playerName: nextPlayer });

    if (isBot(nextPlayer)) scheduleBotPlay(roomCode, nextPlayer);
}

// Bot "thinks" 1.5s, picks a random arrow, waits for animation, then advances turn
function scheduleBotPlay(roomCode, botName) {
    setTimeout(() => {
        const room = rooms[roomCode];
        if (!room) return;
        // Make sure it's still this bot's turn
        if (room.players[room.currentTurnIndex] !== botName) return;

        const arrowCount = room.arrowCount || 8;
        const arrowIndex = Math.floor(Math.random() * arrowCount);
        io.to(roomCode).emit('arrowClicked', { arrowIndex });

        // Wait for arrow move + reverse animation (~6s), then next turn
        setTimeout(() => {
            const r = rooms[roomCode];
            if (!r) return;
            if (r.players[r.currentTurnIndex] !== botName) return;
            advanceTurn(roomCode);
        }, 6000);

    }, 1500); // thinking delay
}

// Countdown → gameStart → first turnStart
function startRoomGame(roomCode) {
    // 4s after countdownStart (3s countdown + 1s "Game Started!")
    setTimeout(() => {
        if (!rooms[roomCode]) return;
        io.to(roomCode).emit('gameStart');

        // 1 extra second for clients to instantiate the level
        setTimeout(() => {
            const room = rooms[roomCode];
            if (!room) return;
            room.currentTurnIndex = 0;
            const firstPlayer = room.players[0];
            io.to(roomCode).emit('turnStart', { playerName: firstPlayer });
            if (isBot(firstPlayer)) scheduleBotPlay(roomCode, firstPlayer);
        }, 1000);

    }, 4000);
}

// Create a room with real + bot players, then start the game
function initRoom(code, players, realSockets, maxPlayers) {
    rooms[code] = {
        players:           [...players],
        maxPlayers:        maxPlayers,
        sockets:           {},
        bots:              players.filter(isBot),
        arrowCount:        0,
        currentTurnIndex:  0,
    };
    realSockets.forEach(s => {
        if (s && s.join) {           // guard: real socket only
            s.join(code);
            s.currentRoom = code;
            rooms[code].sockets[s.playerName] = s;
        }
    });
    io.to(code).emit('playerList', players);
    io.to(code).emit('countdownStart');
    startRoomGame(code);
}

function leaveRoom(socket) {
    const room = socket.currentRoom;
    if (!room || !rooms[room]) return;
    const playerName = socket.playerName;
    rooms[room].players = rooms[room].players.filter(p => p !== playerName);
    delete rooms[room].sockets[playerName];
    socket.leave(room);
    socket.currentRoom = null;
    if (rooms[room].players.filter(p => !isBot(p)).length === 0) {
        delete rooms[room]; // everyone real has left
    } else {
        io.to(room).emit('playerLeft', playerName);
        io.to(room).emit('playerList', rooms[room].players);
    }
}

// ─── Free matchmaking ─────────────────────────────────────────────────────────
function broadcastQueueUpdate() {
    matchQueue.forEach(s => s.emit('matchmakingUpdate', { playerCount: matchQueue.length, timeLeft: matchTimeLeft }));
}

function startMatchTimer() {
    if (matchTimer) return;
    matchTimeLeft = 10;
    matchTimer = setInterval(() => {
        matchTimeLeft--;
        broadcastQueueUpdate();
        if (matchTimeLeft <= 0) {
            clearInterval(matchTimer); matchTimer = null;
            if (matchQueue.length >= 2) {
                const group = matchQueue.splice(0);
                const players = group.map(s => s.playerName);
                const code = makeRoomCode();
                initRoom(code, players, group, players.length);
                group.forEach(s => s.emit('matchFound', code));
            } else if (matchQueue.length === 1) {
                matchQueue.splice(0)[0].emit('matchmakingFailed');
            }
        }
    }, 1000);
}

// ─── Coin matchmaking (4P) ────────────────────────────────────────────────────
function broadcastCoinQueueUpdate() {
    coinQueue.forEach(s => s.emit('coinMatchUpdate', { playerCount: coinQueue.length }));
}

function startCoinQueueTimer() {
    if (coinQueueTimer) return;
    let remaining = COIN_WAIT_SECONDS;
    coinQueueTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(coinQueueTimer); coinQueueTimer = null;
            if (coinQueue.length === 0) return;
            const real    = coinQueue.splice(0);
            const players = real.map(s => s.playerName);
            let botNum = 1;
            while (players.length < 4) players.push('Bot ' + botNum++);
            const code = makeRoomCode();
            initRoom(code, players, real, 4);
            real.forEach(s => s.emit('coinMatchFound', code));
        }
    }, 1000);
}

// ─── Coin matchmaking (2P) ────────────────────────────────────────────────────
function broadcastCoinQueue2Update() {
    coinQueue2.forEach(s => s.emit('coinMatch2Update', { playerCount: coinQueue2.length }));
}

function startCoinQueue2Timer() {
    if (coinQueue2Timer) return;
    let remaining = COIN_WAIT_SECONDS;
    coinQueue2Timer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(coinQueue2Timer); coinQueue2Timer = null;
            if (coinQueue2.length === 0) return;
            const real    = coinQueue2.splice(0);
            const players = real.map(s => s.playerName);
            let botNum = 1;
            while (players.length < 2) players.push('Bot ' + botNum++);
            const code = makeRoomCode();
            initRoom(code, players, real, 2);
            real.forEach(s => s.emit('coinMatch2Found', code));
        }
    }, 1000);
}

// ─── Socket connection ────────────────────────────────────────────────────────
io.on('connection', socket => {
    console.log('connected:', socket.id);

    // CREATE ROOM
    socket.on('createRoom', ({ playerName, playerCount }) => {
        const code = makeRoomCode();
        const max  = (playerCount >= 2 && playerCount <= 4) ? playerCount : 4;
        socket.playerName  = playerName;
        socket.currentRoom = code;
        rooms[code] = {
            players: [playerName], maxPlayers: max,
            sockets: { [playerName]: socket },
            bots: [], arrowCount: 0, currentTurnIndex: 0,
        };
        socket.join(code);
        socket.emit('roomCreated', code);
        io.to(code).emit('playerList', rooms[code].players);
    });

    // JOIN ROOM
    socket.on('joinRoom', ({ roomName, playerName }) => {
        const room = rooms[roomName];
        if (!room)                               { socket.emit('roomNotFound'); return; }
        if (room.players.length >= room.maxPlayers) { socket.emit('roomFull');    return; }

        socket.playerName  = playerName;
        socket.currentRoom = roomName;
        room.players.push(playerName);
        room.sockets[playerName] = socket;
        socket.join(roomName);

        socket.emit('joinedRoom', roomName);
        io.to(roomName).emit('playerJoined', playerName);
        io.to(roomName).emit('playerList', room.players);

        if (room.players.length === room.maxPlayers) {
            io.to(roomName).emit('countdownStart');
            startRoomGame(roomName);
        }
    });

    // LEAVE ROOM
    socket.on('leaveRoom', () => leaveRoom(socket));

    // ARROW COUNT (client reports after level loads — used for bot clicks)
    socket.on('arrowCount', ({ count }) => {
        const room = socket.currentRoom;
        if (room && rooms[room] && count > 0)
            rooms[room].arrowCount = count;
    });

    // ARROW CLICKED
    socket.on('arrowClicked', ({ arrowIndex }) => {
        const room = socket.currentRoom;
        if (room) io.to(room).emit('arrowClicked', { arrowIndex });
    });

    // TURN DONE (real player finished animation)
    socket.on('turnDone', () => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        advanceTurn(room);
    });

    // FREE MATCHMAKING
    socket.on('joinMatchmaking', ({ playerName }) => {
        socket.playerName = playerName;
        if (!matchQueue.find(s => s.id === socket.id)) matchQueue.push(socket);
        broadcastQueueUpdate();
        startMatchTimer();
    });

    socket.on('leaveMatchmaking', () => {
        matchQueue = matchQueue.filter(s => s.id !== socket.id);
        if (matchQueue.length === 0 && matchTimer) { clearInterval(matchTimer); matchTimer = null; }
    });

    // COIN MATCHMAKING (4P)
    socket.on('joinCoinMatch', ({ playerName }) => {
        socket.playerName = playerName;
        if (!coinQueue.find(s => s.id === socket.id)) coinQueue.push(socket);
        broadcastCoinQueueUpdate();
        if (coinQueue.length >= 4) {
            clearInterval(coinQueueTimer); coinQueueTimer = null;
            const group   = coinQueue.splice(0, 4);
            const players = group.map(s => s.playerName);
            const code    = makeRoomCode();
            initRoom(code, players, group, 4);
            group.forEach(s => s.emit('coinMatchFound', code));
        } else {
            startCoinQueueTimer();
        }
    });

    socket.on('leaveCoinMatch', () => {
        coinQueue = coinQueue.filter(s => s.id !== socket.id);
        if (coinQueue.length === 0 && coinQueueTimer) { clearInterval(coinQueueTimer); coinQueueTimer = null; }
        broadcastCoinQueueUpdate();
    });

    // COIN MATCHMAKING (2P)
    socket.on('joinCoinMatch2', ({ playerName }) => {
        socket.playerName = playerName;
        if (!coinQueue2.find(s => s.id === socket.id)) coinQueue2.push(socket);
        broadcastCoinQueue2Update();
        if (coinQueue2.length >= 2) {
            clearInterval(coinQueue2Timer); coinQueue2Timer = null;
            const group   = coinQueue2.splice(0, 2);
            const players = group.map(s => s.playerName);
            const code    = makeRoomCode();
            initRoom(code, players, group, 2);
            group.forEach(s => s.emit('coinMatch2Found', code));
        } else {
            startCoinQueue2Timer();
        }
    });

    socket.on('leaveCoinMatch2', () => {
        coinQueue2 = coinQueue2.filter(s => s.id !== socket.id);
        if (coinQueue2.length === 0 && coinQueue2Timer) { clearInterval(coinQueue2Timer); coinQueue2Timer = null; }
        broadcastCoinQueue2Update();
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('disconnected:', socket.id);
        matchQueue  = matchQueue.filter(s => s.id !== socket.id);
        coinQueue   = coinQueue.filter(s => s.id !== socket.id);
        coinQueue2  = coinQueue2.filter(s => s.id !== socket.id);
        if (matchQueue.length  === 0 && matchTimer)      { clearInterval(matchTimer);      matchTimer      = null; }
        if (coinQueue.length   === 0 && coinQueueTimer)  { clearInterval(coinQueueTimer);  coinQueueTimer  = null; }
        if (coinQueue2.length  === 0 && coinQueue2Timer) { clearInterval(coinQueue2Timer); coinQueue2Timer = null; }
        leaveRoom(socket);
    });
});

server.listen(PORT, () => console.log('Server listening on port ' + PORT));