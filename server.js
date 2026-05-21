'use strict';

const http = require('http');
const socket = require('socket.io');
const server = http.createServer();
const port = 11100;

var io = socket(server, {
    pingInterval: 10000,
    pingTimeout: 5000
});

io.use((socket, next) => {
    if (socket.handshake.query.token === "UNITY") {
        next();
    } else {
        next(new Error("Authentication error"));
    }
});

// ─── ROOM HELPERS ────────────────────────────────────────────────────────────

const rooms = {};       // roomCode → { players, maxPlayers, currentTurnIndex, arrowCount }
const playerRoom = {};  // socketId → roomCode

function generateCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function isBot(name) {
    return name.startsWith('Bot ');
}

// Build room, assign players, emit playerList — but do NOT start countdown yet
function setupRoom(playerSockets, roomCode, maxPlayers) {
    const playerNames = playerSockets.map(s => s.playerName);
    rooms[roomCode] = { players: playerNames, maxPlayers, currentTurnIndex: 0, arrowCount: 10 };
    playerSockets.forEach(s => {
        if (!s.isFake) {
            playerRoom[s.id] = roomCode;
            s.join(roomCode);
        }
    });
    io.to(roomCode).emit('playerList', playerNames);
}

// Emit countdownStart then start the game sequence
function kickoffGame(roomCode) {
    io.to(roomCode).emit('countdownStart');
    setTimeout(() => startRoomGame(roomCode), 4000);
}

function startRoomGame(roomCode) {
    io.to(roomCode).emit('gameStart');
    setTimeout(() => {
        const r = rooms[roomCode];
        if (!r) return;
        const firstPlayer = r.players[r.currentTurnIndex];
        io.to(roomCode).emit('turnStart', { playerName: firstPlayer });
        if (isBot(firstPlayer)) scheduleBotPlay(roomCode, firstPlayer);
    }, 1000);
}

function advanceTurn(roomCode) {
    const r = rooms[roomCode];
    if (!r) return;
    r.currentTurnIndex = (r.currentTurnIndex + 1) % r.players.length;
    const nextPlayer = r.players[r.currentTurnIndex];
    io.to(roomCode).emit('turnStart', { playerName: nextPlayer });
    if (isBot(nextPlayer)) scheduleBotPlay(roomCode, nextPlayer);
}

function scheduleBotPlay(roomCode, botName) {
    setTimeout(() => {
        const r = rooms[roomCode];
        if (!r) return;
        const arrowCount = r.arrowCount || 10;
        const arrowIndex = Math.floor(Math.random() * arrowCount);
        io.to(roomCode).emit('arrowClicked', { arrowIndex });

        // Fallback: if no real player sent turnDone within 6s, advance ourselves
        setTimeout(() => {
            const rr = rooms[roomCode];
            if (!rr) return;
            if (rr.players[rr.currentTurnIndex] !== botName) return; // already advanced
            advanceTurn(roomCode);
        }, 6000);
    }, 1500);
}

// ─── COIN QUEUE FACTORY ───────────────────────────────────────────────────────

const COIN_WAIT_SECONDS = 30;

function makeCoinQueueHandler(queue, state, updateEvent, foundEvent, maxPlayers) {

    function broadcast() {
        queue.forEach(s => s.emit(updateEvent, { playerCount: queue.length, timeLeft: state.timeLeft }));
    }

    function startTimer() {
        if (state.timer) return; // already running
        state.timeLeft = COIN_WAIT_SECONDS;
        state.timer = setInterval(() => {
            state.timeLeft--;
            broadcast();
            if (state.timeLeft <= 0) {
                clearInterval(state.timer);
                state.timer = null;
                fillWithBotsAndStart();
            }
        }, 1000);
    }

    function fillWithBotsAndStart() {
        let botNum = 1;
        while (queue.length < maxPlayers) {
            queue.push({ playerName: 'Bot ' + botNum++, isFake: true });
        }

        const roomCode = generateCode();
        const realSockets = queue.filter(s => !s.isFake);
        const allSockets  = [...queue];

        // Emit match-found FIRST, then clear queue
        realSockets.forEach(s => s.emit(foundEvent, roomCode));

        queue.length = 0;
        state.timeLeft = COIN_WAIT_SECONDS;

        setupRoom(allSockets, roomCode, maxPlayers);
        kickoffGame(roomCode);
    }

    function join(socket) {
        if (queue.find(s => s.id === socket.id)) return;
        socket.playerName = socket.handshake.query.playerName || socket.playerName || 'Player';
        queue.push(socket);

        // Send current state immediately to the joining socket
        socket.emit(updateEvent, { playerCount: queue.length, timeLeft: state.timeLeft });
        broadcast();

        if (queue.length >= maxPlayers) {
            clearInterval(state.timer);
            state.timer = null;

            const roomCode = generateCode();
            const snap = [...queue];
            snap.forEach(s => s.emit(foundEvent, roomCode));
            queue.length = 0;
            state.timeLeft = COIN_WAIT_SECONDS;

            setupRoom(snap, roomCode, maxPlayers);
            kickoffGame(roomCode);
        } else {
            startTimer();
        }
    }

    function leave(socket) {
        const idx = queue.findIndex(s => s.id === socket.id);
        if (idx !== -1) queue.splice(idx, 1);
        if (queue.length === 0) {
            clearInterval(state.timer);
            state.timer = null;
            state.timeLeft = COIN_WAIT_SECONDS;
        } else {
            broadcast();
        }
    }

    function cleanup(socket) { leave(socket); }

    return { join, leave, cleanup };
}

// ─── COIN QUEUES ──────────────────────────────────────────────────────────────

// 4-player queues
const coinQueue  = []; const cq1  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 4P 250/ea → pool 1000
const coinQueue3 = []; const cq3  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 4P 200/ea → pool 800
const coinQueue4 = []; const cq4  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 4P 400/ea → pool 1600
const coinQueue5 = []; const cq5  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 4P 800/ea → pool 3200
const coinQueue6 = []; const cq6  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 4P 1000/ea→ pool 4000

// 3-player queues
const coinQueue10 = []; const cq10 = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 3P 200/ea → pool 600
const coinQueue11 = []; const cq11 = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 3P 400/ea → pool 1200
const coinQueue12 = []; const cq12 = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 3P 800/ea → pool 2400
const coinQueue13 = []; const cq13 = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 3P 1000/ea→ pool 3000

// 2-player queues
const coinQueue2 = []; const cq2  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 2P 1000/ea→ pool 2000
const coinQueue7 = []; const cq7  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 2P 200/ea → pool 400
const coinQueue8 = []; const cq8  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 2P 400/ea → pool 800
const coinQueue9 = []; const cq9  = { timer: null, timeLeft: COIN_WAIT_SECONDS }; // 2P 800/ea → pool 1600

const h1  = makeCoinQueueHandler(coinQueue,   cq1,  'coinMatchUpdate',   'coinMatchFound',   4);
const h3  = makeCoinQueueHandler(coinQueue3,  cq3,  'coinMatch3Update',  'coinMatch3Found',  4);
const h4  = makeCoinQueueHandler(coinQueue4,  cq4,  'coinMatch4Update',  'coinMatch4Found',  4);
const h5  = makeCoinQueueHandler(coinQueue5,  cq5,  'coinMatch5Update',  'coinMatch5Found',  4);
const h6  = makeCoinQueueHandler(coinQueue6,  cq6,  'coinMatch6Update',  'coinMatch6Found',  4);

const h10 = makeCoinQueueHandler(coinQueue10, cq10, 'coinMatch10Update', 'coinMatch10Found', 3);
const h11 = makeCoinQueueHandler(coinQueue11, cq11, 'coinMatch11Update', 'coinMatch11Found', 3);
const h12 = makeCoinQueueHandler(coinQueue12, cq12, 'coinMatch12Update', 'coinMatch12Found', 3);
const h13 = makeCoinQueueHandler(coinQueue13, cq13, 'coinMatch13Update', 'coinMatch13Found', 3);

const h2  = makeCoinQueueHandler(coinQueue2,  cq2,  'coinMatch2Update',  'coinMatch2Found',  2);
const h7  = makeCoinQueueHandler(coinQueue7,  cq7,  'coinMatch7Update',  'coinMatch7Found',  2);
const h8  = makeCoinQueueHandler(coinQueue8,  cq8,  'coinMatch8Update',  'coinMatch8Found',  2);
const h9  = makeCoinQueueHandler(coinQueue9,  cq9,  'coinMatch9Update',  'coinMatch9Found',  2);

// ─── MATCHMAKING (free, no coins) ────────────────────────────────────────────

const matchmakingQueue = [];
let matchmakingTimer = null;
const MATCHMAKING_WAIT = 10;
let matchmakingTimeLeft = MATCHMAKING_WAIT;

function startMatchmakingTimer() {
    if (matchmakingTimer) return;
    matchmakingTimeLeft = MATCHMAKING_WAIT;
    matchmakingTimer = setInterval(() => {
        matchmakingTimeLeft--;
        matchmakingQueue.forEach(s =>
            s.emit('matchmakingUpdate', { playerCount: matchmakingQueue.length, timeLeft: matchmakingTimeLeft })
        );
        if (matchmakingTimeLeft <= 0) {
            clearInterval(matchmakingTimer);
            matchmakingTimer = null;
            if (matchmakingQueue.length >= 2) {
                formMatchmakingRoom();
            } else {
                matchmakingQueue.forEach(s => s.emit('matchmakingFailed'));
                matchmakingQueue.length = 0;
            }
        }
    }, 1000);
}

function formMatchmakingRoom() {
    const roomCode = generateCode();
    const snap = [...matchmakingQueue];
    snap.forEach(s => s.emit('matchFound', roomCode));
    matchmakingQueue.length = 0;
    matchmakingTimeLeft = MATCHMAKING_WAIT;
    setupRoom(snap, roomCode, snap.length);
    kickoffGame(roomCode);
}

// ─── CONNECTION ───────────────────────────────────────────────────────────────

io.on('connection', socket => {
    console.log('connection', socket.id);

    // ── Free matchmaking ──────────────────────────────────────────────────────

    socket.on('joinMatchmaking', data => {
        socket.playerName = data.playerName;
        if (matchmakingQueue.find(s => s.id === socket.id)) return;
        matchmakingQueue.push(socket);
        matchmakingQueue.forEach(s =>
            s.emit('matchmakingUpdate', { playerCount: matchmakingQueue.length, timeLeft: matchmakingTimeLeft })
        );
        if (matchmakingQueue.length >= 4) {
            clearInterval(matchmakingTimer);
            matchmakingTimer = null;
            formMatchmakingRoom();
        } else {
            startMatchmakingTimer();
        }
    });

    socket.on('leaveMatchmaking', () => {
        const idx = matchmakingQueue.findIndex(s => s.id === socket.id);
        if (idx !== -1) matchmakingQueue.splice(idx, 1);
        if (matchmakingQueue.length === 0) {
            clearInterval(matchmakingTimer);
            matchmakingTimer = null;
            matchmakingTimeLeft = MATCHMAKING_WAIT;
        }
    });

    // ── Create / Join named room ──────────────────────────────────────────────

    socket.on('createRoom', data => {
        const { playerName, playerCount } = data;
        socket.playerName = playerName;
        const roomCode = generateCode();
        rooms[roomCode] = { players: [playerName], maxPlayers: playerCount || 4, currentTurnIndex: 0, arrowCount: 10 };
        playerRoom[socket.id] = roomCode;
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        io.to(roomCode).emit('playerList', rooms[roomCode].players);
    });

    socket.on('joinRoom', data => {
        const { roomName, playerName } = data;
        socket.playerName = playerName;
        const r = rooms[roomName];
        if (!r) { socket.emit('roomNotFound'); return; }
        if (r.players.length >= r.maxPlayers) { socket.emit('roomFull'); return; }

        r.players.push(playerName);
        playerRoom[socket.id] = roomName;
        socket.join(roomName);
        socket.emit('joinedRoom', roomName);
        io.to(roomName).emit('playerList', r.players);
        io.to(roomName).emit('playerJoined', playerName);

        if (r.players.length >= r.maxPlayers) kickoffGame(roomName);
    });

    // ── Coin match queues — 4-player ─────────────────────────────────────────

    socket.on('joinCoinMatch',  data => { socket.playerName = data.playerName; h1.join(socket); });
    socket.on('leaveCoinMatch', ()   => h1.leave(socket));

    socket.on('joinCoinMatch3',  data => { socket.playerName = data.playerName; h3.join(socket); });
    socket.on('leaveCoinMatch3', ()   => h3.leave(socket));

    socket.on('joinCoinMatch4',  data => { socket.playerName = data.playerName; h4.join(socket); });
    socket.on('leaveCoinMatch4', ()   => h4.leave(socket));

    socket.on('joinCoinMatch5',  data => { socket.playerName = data.playerName; h5.join(socket); });
    socket.on('leaveCoinMatch5', ()   => h5.leave(socket));

    socket.on('joinCoinMatch6',  data => { socket.playerName = data.playerName; h6.join(socket); });
    socket.on('leaveCoinMatch6', ()   => h6.leave(socket));

    // ── Coin match queues — 3-player ─────────────────────────────────────────

    socket.on('joinCoinMatch10',  data => { socket.playerName = data.playerName; h10.join(socket); });
    socket.on('leaveCoinMatch10', ()   => h10.leave(socket));

    socket.on('joinCoinMatch11',  data => { socket.playerName = data.playerName; h11.join(socket); });
    socket.on('leaveCoinMatch11', ()   => h11.leave(socket));

    socket.on('joinCoinMatch12',  data => { socket.playerName = data.playerName; h12.join(socket); });
    socket.on('leaveCoinMatch12', ()   => h12.leave(socket));

    socket.on('joinCoinMatch13',  data => { socket.playerName = data.playerName; h13.join(socket); });
    socket.on('leaveCoinMatch13', ()   => h13.leave(socket));

    // ── Coin match queues — 2-player ─────────────────────────────────────────

    socket.on('joinCoinMatch2',  data => { socket.playerName = data.playerName; h2.join(socket); });
    socket.on('leaveCoinMatch2', ()   => h2.leave(socket));

    socket.on('joinCoinMatch7',  data => { socket.playerName = data.playerName; h7.join(socket); });
    socket.on('leaveCoinMatch7', ()   => h7.leave(socket));

    socket.on('joinCoinMatch8',  data => { socket.playerName = data.playerName; h8.join(socket); });
    socket.on('leaveCoinMatch8', ()   => h8.leave(socket));

    socket.on('joinCoinMatch9',  data => { socket.playerName = data.playerName; h9.join(socket); });
    socket.on('leaveCoinMatch9', ()   => h9.leave(socket));

    // ── In-game events ────────────────────────────────────────────────────────

    socket.on('arrowCount', data => {
        const roomCode = playerRoom[socket.id];
        if (!roomCode || !rooms[roomCode]) return;
        rooms[roomCode].arrowCount = data.count;
    });

    socket.on('arrowClicked', data => {
        const roomCode = playerRoom[socket.id];
        if (!roomCode) return;
        io.to(roomCode).emit('arrowClicked', { arrowIndex: data.arrowIndex });
    });

    socket.on('turnDone', () => {
        const roomCode = playerRoom[socket.id];
        if (!roomCode) return;
        advanceTurn(roomCode);
    });

    socket.on('leaveRoom', () => {
        const roomCode = playerRoom[socket.id];
        if (!roomCode) return;
        const r = rooms[roomCode];
        if (r) {
            io.to(roomCode).emit('playerLeft', socket.playerName);
            r.players = r.players.filter(p => p !== socket.playerName);
            if (r.players.length === 0) delete rooms[roomCode];
            else io.to(roomCode).emit('playerList', r.players);
        }
        delete playerRoom[socket.id];
        socket.leave(roomCode);
    });

    // ── Disconnect cleanup ────────────────────────────────────────────────────

    socket.on('disconnect', () => {
        console.log('disconnect', socket.id);

        // Free matchmaking cleanup
        const mIdx = matchmakingQueue.findIndex(s => s.id === socket.id);
        if (mIdx !== -1) matchmakingQueue.splice(mIdx, 1);

        // 4P coin queue cleanup
        h1.cleanup(socket); h3.cleanup(socket); h4.cleanup(socket);
        h5.cleanup(socket); h6.cleanup(socket);

        // 3P coin queue cleanup
        h10.cleanup(socket); h11.cleanup(socket);
        h12.cleanup(socket); h13.cleanup(socket);

        // 2P coin queue cleanup
        h2.cleanup(socket); h7.cleanup(socket);
        h8.cleanup(socket); h9.cleanup(socket);

        // Room cleanup
        const roomCode = playerRoom[socket.id];
        if (roomCode) {
            const r = rooms[roomCode];
            if (r) {
                io.to(roomCode).emit('playerLeft', socket.playerName);
                r.players = r.players.filter(p => p !== socket.playerName);
                if (r.players.length === 0) delete rooms[roomCode];
                else io.to(roomCode).emit('playerList', r.players);
            }
            delete playerRoom[socket.id];
        }
    });

    // ── Legacy sample events ──────────────────────────────────────────────────

    socket.on('hello', data => {
        console.log('hello', data);
        socket.emit('hello', { date: new Date().getTime(), data });
    });

    socket.on('spin', data => {
        console.log('spin');
        socket.emit('spin', { date: new Date().getTime(), data });
    });

    socket.on('class', data => {
        console.log('class', data);
        socket.emit('class', { date: new Date().getTime(), data });
    });
});

server.listen(port, () => {
    console.log('listening on *:' + port);
});