'use strict';

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer();
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ─── State ────────────────────────────────────────────────────────────────────
const rooms    = {};
let matchQueue = [];
let coinQueue  = [];   // 4P — 1000 coins (250 each)
let coinQueue2 = [];   // 2P — 2000 coins (1000 each)
let coinQueue3 = [];   // 4P —  800 coins (200 each)
let coinQueue4 = [];   // 4P — 1600 coins (400 each)
let coinQueue5 = [];   // 4P — 3200 coins (800 each)

let matchTimer    = null;
let matchTimeLeft = 10;

const COIN_WAIT_SECONDS = 30;

// Per-queue state: timer handle + current timeLeft
const cq1 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const cq2 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const cq3 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const cq4 = { timer: null, timeLeft: COIN_WAIT_SECONDS };
const cq5 = { timer: null, timeLeft: COIN_WAIT_SECONDS };

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

function advanceTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    const next = ((room.currentTurnIndex ?? 0) + 1) % room.players.length;
    room.currentTurnIndex = next;
    const nextPlayer = room.players[next];

    io.to(roomCode).emit('turnStart', { playerName: nextPlayer });

    if (isBot(nextPlayer)) scheduleBotPlay(roomCode, nextPlayer);
}

function scheduleBotPlay(roomCode, botName) {
    setTimeout(() => {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.players[room.currentTurnIndex] !== botName) return;

        const arrowCount = room.arrowCount || 8;
        const arrowIndex = Math.floor(Math.random() * arrowCount);
        io.to(roomCode).emit('arrowClicked', { arrowIndex });

        setTimeout(() => {
            const r = rooms[roomCode];
            if (!r) return;
            if (r.players[r.currentTurnIndex] !== botName) return;
            advanceTurn(roomCode);
        }, 6000);

    }, 1500);
}

function startRoomGame(roomCode) {
    setTimeout(() => {
        if (!rooms[roomCode]) return;
        io.to(roomCode).emit('gameStart');

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

// Step 1: create room + join sockets, send playerList — NO countdown yet
function setupRoom(code, players, realSockets, maxPlayers) {
    rooms[code] = {
        players:          [...players],
        maxPlayers:       maxPlayers,
        sockets:          {},
        bots:             players.filter(isBot),
        arrowCount:       0,
        currentTurnIndex: 0,
    };
    realSockets.forEach(s => {
        if (s && s.join) {
            s.join(code);
            s.currentRoom = code;
            rooms[code].sockets[s.playerName] = s;
        }
    });
    io.to(code).emit('playerList', players);
}

// Step 2: send countdown + start game — call AFTER match-found events
function kickoffGame(code) {
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
        delete rooms[room];
    } else {
        io.to(room).emit('playerLeft', playerName);
        io.to(room).emit('playerList', rooms[room].players);
    }
}

// ─── Generic coin queue handler ───────────────────────────────────────────────
// queue      : the array (coinQueue, coinQueue2, …)
// state      : { timer, timeLeft }
// updateEvent: e.g. 'coinMatchUpdate'
// foundEvent : e.g. 'coinMatchFound'
// maxPlayers : 2 or 4
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
                clearInterval(state.timer); state.timer = null;
                if (queue.length === 0) return;
                const real    = queue.splice(0);
                const players = real.map(s => s.playerName);
                let botNum = 1;
                while (players.length < maxPlayers) players.push('Bot ' + botNum++);
                const code = makeRoomCode();
                setupRoom(code, players, real, maxPlayers);
                real.forEach(s => s.emit(foundEvent, code)); // ← match found FIRST
                kickoffGame(code);                           // ← countdown AFTER
            }
        }, 1000);
    }

    function join(socket) {
        if (!queue.find(s => s.id === socket.id)) queue.push(socket);
        // Send current timeLeft to the joining player immediately
        socket.emit(updateEvent, { playerCount: queue.length, timeLeft: state.timeLeft });
        broadcast();

        if (queue.length >= maxPlayers) {
            clearInterval(state.timer); state.timer = null;
            const group   = queue.splice(0, maxPlayers);
            const players = group.map(s => s.playerName);
            const code    = makeRoomCode();
            setupRoom(code, players, group, maxPlayers);
            group.forEach(s => s.emit(foundEvent, code)); // ← match found FIRST
            kickoffGame(code);                            // ← countdown AFTER
        } else {
            startTimer();
        }
    }

    function leave(socket) {
        const idx = queue.findIndex(s => s.id === socket.id);
        if (idx !== -1) queue.splice(idx, 1);
        if (queue.length === 0 && state.timer) {
            clearInterval(state.timer);
            state.timer    = null;
            state.timeLeft = COIN_WAIT_SECONDS;
        }
        broadcast();
    }

    function cleanup(socket) {
        const idx = queue.findIndex(s => s.id === socket.id);
        if (idx !== -1) {
            queue.splice(idx, 1);
            if (queue.length === 0 && state.timer) {
                clearInterval(state.timer);
                state.timer    = null;
                state.timeLeft = COIN_WAIT_SECONDS;
            }
        }
    }

    return { join, leave, cleanup };
}

// Build handlers for each queue
const h1 = makeCoinQueueHandler(coinQueue,  cq1, 'coinMatchUpdate',  'coinMatchFound',  4);
const h2 = makeCoinQueueHandler(coinQueue2, cq2, 'coinMatch2Update', 'coinMatch2Found', 2);
const h3 = makeCoinQueueHandler(coinQueue3, cq3, 'coinMatch3Update', 'coinMatch3Found', 4);
const h4 = makeCoinQueueHandler(coinQueue4, cq4, 'coinMatch4Update', 'coinMatch4Found', 4);
const h5 = makeCoinQueueHandler(coinQueue5, cq5, 'coinMatch5Update', 'coinMatch5Found', 4);

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
                const group   = matchQueue.splice(0);
                const players = group.map(s => s.playerName);
                const code    = makeRoomCode();
                setupRoom(code, players, group, players.length);
                group.forEach(s => s.emit('matchFound', code));
                kickoffGame(code);
            } else if (matchQueue.length === 1) {
                matchQueue.splice(0)[0].emit('matchmakingFailed');
            }
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
        if (!room)                                  { socket.emit('roomNotFound'); return; }
        if (room.players.length >= room.maxPlayers) { socket.emit('roomFull');    return; }

        socket.playerName  = playerName;
        socket.currentRoom = roomName;
        room.players.push(playerName);
        room.sockets[playerName] = socket;
        socket.join(roomName);

        socket.emit('joinedRoom', roomName);
        io.to(roomName).emit('playerJoined', playerName);
        io.to(roomName).emit('playerList', room.players);

        if (room.players.length === room.maxPlayers)
            kickoffGame(roomName);
    });

    // LEAVE ROOM
    socket.on('leaveRoom', () => leaveRoom(socket));

    // ARROW COUNT
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

    // TURN DONE
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

    // COIN MATCHMAKING — 4P 1000
    socket.on('joinCoinMatch',  ({ playerName }) => { socket.playerName = playerName; h1.join(socket);  });
    socket.on('leaveCoinMatch',  ()              => h1.leave(socket));

    // COIN MATCHMAKING — 2P 2000
    socket.on('joinCoinMatch2', ({ playerName }) => { socket.playerName = playerName; h2.join(socket);  });
    socket.on('leaveCoinMatch2', ()              => h2.leave(socket));

    // COIN MATCHMAKING — 4P 800
    socket.on('joinCoinMatch3', ({ playerName }) => { socket.playerName = playerName; h3.join(socket);  });
    socket.on('leaveCoinMatch3', ()              => h3.leave(socket));

    // COIN MATCHMAKING — 4P 1600
    socket.on('joinCoinMatch4', ({ playerName }) => { socket.playerName = playerName; h4.join(socket);  });
    socket.on('leaveCoinMatch4', ()              => h4.leave(socket));

    // COIN MATCHMAKING — 4P 3200
    socket.on('joinCoinMatch5', ({ playerName }) => { socket.playerName = playerName; h5.join(socket);  });
    socket.on('leaveCoinMatch5', ()              => h5.leave(socket));

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('disconnected:', socket.id);
        matchQueue = matchQueue.filter(s => s.id !== socket.id);
        if (matchQueue.length === 0 && matchTimer) { clearInterval(matchTimer); matchTimer = null; }
        h1.cleanup(socket);
        h2.cleanup(socket);
        h3.cleanup(socket);
        h4.cleanup(socket);
        h5.cleanup(socket);
        leaveRoom(socket);
    });
});

server.listen(PORT, () => console.log('Server listening on port ' + PORT));