'use strict';

const http = require('http');
const { Server } = require('socket.io');
const port = process.env.PORT || 11100;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Aroodo Multiplayer Server is running.');
});

const io = new Server(server, {
    pingInterval: 10000,
    pingTimeout: 5000,
    cors: { origin: "*" }
});

io.use((socket, next) => {
    if (socket.handshake.query.token === "UNITY") {
        next();
    } else {
        next(new Error("Authentication error"));
    }
});

// ─── ROOM HELPERS ─────────────────────────────────────────────────────

const rooms = {};
const playerRoom = {};

function generateCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function isBot(name) { return name.startsWith('Bot '); }

function setupRoom(playerSockets, roomCode, maxPlayers) {
    const playerNames = playerSockets.map(s => s.playerName);
    const profiles = {};
    playerSockets.forEach(s => { profiles[s.playerName] = s.profileNumber || 0; });
    rooms[roomCode] = { players: playerNames, maxPlayers, currentTurnIndex: 0, arrowCount: 10, profiles };
    playerSockets.forEach(s => {
        if (!s.isFake) {
            playerRoom[s.id] = roomCode;
            s.join(roomCode);
        }
    });
    io.to(roomCode).emit('playerList', playerNames);
    io.to(roomCode).emit('playerProfiles', profiles);
}

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
    // The delegate client now picks the arrow (easy = random, medium = strategic)
    // and sends arrowClicked itself — we no longer auto-click here.
    // We only keep a fallback: if the delegate fails to act within 15 s, skip the turn.
    setTimeout(() => {
        const r = rooms[roomCode];
        if (!r) return;
        if (r.players[r.currentTurnIndex] !== botName) return; // delegate already handled it
        advanceTurn(roomCode); // fallback: delegate timed out or disconnected
    }, 15000);
}


// ─── COIN QUEUE FACTORY ───────────────────────────────────────────────────────

const COIN_WAIT_SECONDS = 30;

function makeCoinQueueHandler(queue, state, updateEvent, foundEvent, maxPlayers) {

    function broadcast() {
        queue.forEach(s => s.emit(updateEvent, { playerCount: queue.length, timeLeft: state.timeLeft }));
    }

    function startTimer() {
        if (state.timer) return;
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
        while (queue.length < maxPlayers)
            queue.push({ playerName: 'Bot ' + botNum++, isFake: true, profileNumber: 0 });
        const roomCode = generateCode();
        const realSockets = queue.filter(s => !s.isFake);
        const allSockets = [...queue];
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
        } else { broadcast(); }
    }

    function cleanup(socket) { leave(socket); }
    return { join, leave, cleanup };
}

// ─── COIN QUEUES ─────────────────────────────────────────────────────────────

const coinQueue = []; const cq1 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue3 = []; const cq3 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue4 = []; const cq4 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue5 = []; const cq5 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue6 = []; const cq6 = { timer: null, timeLeft: COIN_WAIT_SECONDS };

const coinQueue10 = []; const cq10 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue11 = []; const cq11 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue12 = []; const cq12 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue13 = []; const cq13 = { timer: null, timeLeft: COIN_WAIT_SECONDS };

const coinQueue2 = []; const cq2 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue7 = []; const cq7 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue8 = []; const cq8 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const coinQueue9 = []; const cq9 = { timer: null, timeLeft: COIN_WAIT_SECONDS };

const h1 = makeCoinQueueHandler(coinQueue, cq1, 'coinMatchUpdate', 'coinMatchFound', 4);
const h3 = makeCoinQueueHandler(coinQueue3, cq3, 'coinMatch3Update', 'coinMatch3Found', 4);
const h4 = makeCoinQueueHandler(coinQueue4, cq4, 'coinMatch4Update', 'coinMatch4Found', 4);
const h5 = makeCoinQueueHandler(coinQueue5, cq5, 'coinMatch5Update', 'coinMatch5Found', 4);
const h6 = makeCoinQueueHandler(coinQueue6, cq6, 'coinMatch6Update', 'coinMatch6Found', 4);

const h10 = makeCoinQueueHandler(coinQueue10, cq10, 'coinMatch10Update', 'coinMatch10Found', 3);
const h11 = makeCoinQueueHandler(coinQueue11, cq11, 'coinMatch11Update', 'coinMatch11Found', 3);
const h12 = makeCoinQueueHandler(coinQueue12, cq12, 'coinMatch12Update', 'coinMatch12Found', 3);
const h13 = makeCoinQueueHandler(coinQueue13, cq13, 'coinMatch13Update', 'coinMatch13Found', 3);

const h2 = makeCoinQueueHandler(coinQueue2, cq2, 'coinMatch2Update', 'coinMatch2Found', 2);
const h7 = makeCoinQueueHandler(coinQueue7, cq7, 'coinMatch7Update', 'coinMatch7Found', 2);
const h8 = makeCoinQueueHandler(coinQueue8, cq8, 'coinMatch8Update', 'coinMatch8Found', 2);
const h9 = makeCoinQueueHandler(coinQueue9, cq9, 'coinMatch9Update', 'coinMatch9Found', 2);

// ─── FREE MATCHMAKING ─────────────────────────────────────────────────────────

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
            if (matchmakingQueue.length >= 2) formMatchmakingRoom();
            else {
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

    socket.on('joinMatchmaking', data => {
        socket.playerName = data.playerName;
        socket.profileNumber = data.profileNumber;
        if (matchmakingQueue.find(s => s.id === socket.id)) return;
        matchmakingQueue.push(socket);
        matchmakingQueue.forEach(s =>
            s.emit('matchmakingUpdate', { playerCount: matchmakingQueue.length, timeLeft: matchmakingTimeLeft })
        );
        if (matchmakingQueue.length >= 4) { clearInterval(matchmakingTimer); matchmakingTimer = null; formMatchmakingRoom(); }
        else startMatchmakingTimer();
    });

    socket.on('leaveMatchmaking', () => {
        const idx = matchmakingQueue.findIndex(s => s.id === socket.id);
        if (idx !== -1) matchmakingQueue.splice(idx, 1);
        if (matchmakingQueue.length === 0) { clearInterval(matchmakingTimer); matchmakingTimer = null; matchmakingTimeLeft = MATCHMAKING_WAIT; }
    });

    // ── FRIEND ROOM — CREATE ──────────────────────────────────────────────────

    socket.on('createRoom', data => {
        const { playerName, playerCount, coinAmount = 0, profileNumber = 0 } = data; // add profileNumber
        socket.playerName = playerName;
        socket.profileNumber = profileNumber;   // add this line
        const roomCode = generateCode();

        rooms[roomCode] = {
            players: [playerName],
            maxPlayers: playerCount || 4,
            currentTurnIndex: 0,
            arrowCount: 10,
            coinAmount: parseInt(coinAmount) || 0,
            profiles: { [playerName]: profileNumber }   // add this line
        };

        playerRoom[socket.id] = roomCode;
        socket.join(roomCode);

        socket.emit('roomCreated', JSON.stringify({ code: roomCode, coinAmount: rooms[roomCode].coinAmount }));
        io.to(roomCode).emit('playerList', rooms[roomCode].players);
        io.to(roomCode).emit('playerProfiles', rooms[roomCode].profiles);   // add this line
    });

    // ── FRIEND ROOM — JOIN ────────────────────────────────────────────────────

    socket.on('joinRoom', data => {
        const { roomName, playerName, profileNumber = 0 } = data;   // add profileNumber
        socket.playerName = playerName;
        socket.profileNumber = profileNumber;   // add this line
        const r = rooms[roomName];

        if (!r) { socket.emit('roomNotFound'); return; }
        if (r.players.length >= r.maxPlayers) { socket.emit('roomFull'); return; }

        r.players.push(playerName);
        if (!r.profiles) r.profiles = {};       // add this line
        r.profiles[playerName] = profileNumber; // add this line
        playerRoom[socket.id] = roomName;
        socket.join(roomName);

        socket.emit('joinedRoom', JSON.stringify({ code: roomName, coinAmount: r.coinAmount || 0 }));
        io.to(roomName).emit('playerList', r.players);
        io.to(roomName).emit('playerProfiles', r.profiles);   // add this line
        io.to(roomName).emit('playerJoined', playerName);

        if (r.players.length >= r.maxPlayers) kickoffGame(roomName);
    });
    // ── COIN QUEUES ───────────────────────────────────────────────────────────

    // 4-player coin queues
    socket.on('joinCoinMatch', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h1.join(socket); });
    socket.on('leaveCoinMatch', () => h1.leave(socket));
    socket.on('joinCoinMatch3', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h3.join(socket); });
    socket.on('leaveCoinMatch3', () => h3.leave(socket));
    socket.on('joinCoinMatch4', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h4.join(socket); });
    socket.on('leaveCoinMatch4', () => h4.leave(socket));
    socket.on('joinCoinMatch5', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h5.join(socket); });
    socket.on('leaveCoinMatch5', () => h5.leave(socket));
    socket.on('joinCoinMatch6', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h6.join(socket); });
    socket.on('leaveCoinMatch6', () => h6.leave(socket));

    // 3-player coin queues
    socket.on('joinCoinMatch10', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h10.join(socket); });
    socket.on('leaveCoinMatch10', () => h10.leave(socket));
    socket.on('joinCoinMatch11', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h11.join(socket); });
    socket.on('leaveCoinMatch11', () => h11.leave(socket));
    socket.on('joinCoinMatch12', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h12.join(socket); });
    socket.on('leaveCoinMatch12', () => h12.leave(socket));
    socket.on('joinCoinMatch13', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h13.join(socket); });
    socket.on('leaveCoinMatch13', () => h13.leave(socket));

    // 2-player coin queues
    socket.on('joinCoinMatch2', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h2.join(socket); });
    socket.on('leaveCoinMatch2', () => h2.leave(socket));
    socket.on('joinCoinMatch7', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h7.join(socket); });
    socket.on('leaveCoinMatch7', () => h7.leave(socket));
    socket.on('joinCoinMatch8', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h8.join(socket); });
    socket.on('leaveCoinMatch8', () => h8.leave(socket));
    socket.on('joinCoinMatch9', d => { socket.playerName = d.playerName; socket.profileNumber = d.profileNumber; h9.join(socket); });
    socket.on('leaveCoinMatch9', () => h9.leave(socket));

    // ── IN-GAME ───────────────────────────────────────────────────────────────

    socket.on('arrowCount', data => {
        const rc = playerRoom[socket.id];
        if (rc && rooms[rc]) rooms[rc].arrowCount = data.count;
    });

    socket.on('arrowClicked', data => {
        const rc = playerRoom[socket.id];
        if (rc) io.to(rc).emit('arrowClicked', { arrowIndex: data.arrowIndex });
    });

    socket.on('turnDone', () => {
        const rc = playerRoom[socket.id];
        if (rc) advanceTurn(rc);
    });

    socket.on('leaveRoom', () => {
        const rc = playerRoom[socket.id];
        if (!rc) return;
        const r = rooms[rc];
        if (r) {
            io.to(rc).emit('playerLeft', socket.playerName);
            r.players = r.players.filter(p => p !== socket.playerName);
            if (r.players.length === 0) delete rooms[rc];
            else io.to(rc).emit('playerList', r.players);
        }
        delete playerRoom[socket.id];
        socket.leave(rc);
    });

    socket.on('disconnect', () => {
        console.log('disconnect', socket.id);
        const mIdx = matchmakingQueue.findIndex(s => s.id === socket.id);
        if (mIdx !== -1) matchmakingQueue.splice(mIdx, 1);
        h1.cleanup(socket); h3.cleanup(socket); h4.cleanup(socket);
        h5.cleanup(socket); h6.cleanup(socket);
        h10.cleanup(socket); h11.cleanup(socket);
        h12.cleanup(socket); h13.cleanup(socket);
        h2.cleanup(socket); h7.cleanup(socket);
        h8.cleanup(socket); h9.cleanup(socket);
        const rc = playerRoom[socket.id];
        if (rc) {
            const r = rooms[rc];
            if (r) {
                io.to(rc).emit('playerLeft', socket.playerName);
                r.players = r.players.filter(p => p !== socket.playerName);
                if (r.players.length === 0) delete rooms[rc];
                else io.to(rc).emit('playerList', r.players);
            }
            delete playerRoom[socket.id];
        }
    });
});

server.listen(port, () => {
    console.log('listening on *:' + port);
});
