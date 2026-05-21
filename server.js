'use strict';

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer();
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ─── State ────────────────────────────────────────────────────────────────────
const rooms     = {};
let matchQueue  = [];
let coinQueue   = [];   // 4P — 1000 coins (250 each)
let coinQueue2  = [];   // 2P — 2000 coins (1000 each)
let coinQueue3  = [];   // 4P — 800  coins (200 each)
let coinQueue4  = [];   // 4P — 1600 coins (400 each)

let matchTimer      = null;
let matchTimeLeft   = 10;
let coinQueueTimer  = null;
let coinQueue2Timer = null;
let coinQueue3Timer = null;
let coinQueue4Timer = null;

let coinQueueTimeLeft  = 30;
let coinQueue2TimeLeft = 30;
let coinQueue3TimeLeft = 30;
let coinQueue4TimeLeft = 30;

const COIN_WAIT_SECONDS = 30;

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

// ─── Coin queue helper ────────────────────────────────────────────────────────
function makeCoinQueue(queue, updateEvent, foundEvent, maxPlayers, timerRef) {
    // timerRef = { timer, timeLeft }
    return {
        broadcast: (tl) => queue.forEach(s => s.emit(updateEvent, { playerCount: queue.length, timeLeft: tl })),
        startTimer: () => {
            if (timerRef.timer) return;
            timerRef.timeLeft = COIN_WAIT_SECONDS;
            timerRef.timer = setInterval(() => {
                timerRef.timeLeft--;
                queue.forEach(s => s.emit(updateEvent, { playerCount: queue.length, timeLeft: timerRef.timeLeft }));
                if (timerRef.timeLeft <= 0) {
                    clearInterval(timerRef.timer); timerRef.timer = null;
                    if (queue.length === 0) return;
                    const real    = queue.splice(0);
                    const players = real.map(s => s.playerName);
                    let botNum = 1;
                    while (players.length < maxPlayers) players.push('Bot ' + botNum++);
                    const code = makeRoomCode();
                    setupRoom(code, players, real, maxPlayers);
                    real.forEach(s => s.emit(foundEvent, code));
                    kickoffGame(code);
                }
            }, 1000);
        },
    };
}

// Queue state objects
const cq1 = { timer: null, timeLeft: 30 };
const cq2 = { timer: null, timeLeft: 30 };
const cq3 = { timer: null, timeLeft: 30 };
const cq4 = { timer: null, timeLeft: 30 };

const cq1h = makeCoinQueue(coinQueue,  'coinMatchUpdate',  'coinMatchFound',  4, cq1);
const cq2h = makeCoinQueue(coinQueue2, 'coinMatch2Update', 'coinMatch2Found', 2, cq2);
const cq3h = makeCoinQueue(coinQueue3, 'coinMatch3Update', 'coinMatch3Found', 4, cq3);
const cq4h = makeCoinQueue(coinQueue4, 'coinMatch4Update', 'coinMatch4Found', 4, cq4);

function handleJoinCoinQueue(queue, handler, socket, foundEvent, maxPlayers) {
    if (!queue.find(s => s.id === socket.id)) queue.push(socket);
    socket.emit(foundEvent.replace('Found', 'Update'), { playerCount: queue.length, timeLeft: handler === cq1h ? cq1.timeLeft : handler === cq2h ? cq2.timeLeft : handler === cq3h ? cq3.timeLeft : cq4.timeLeft });
    handler.broadcast(handler === cq1h ? cq1.timeLeft : handler === cq2h ? cq2.timeLeft : handler === cq3h ? cq3.timeLeft : cq4.timeLeft);
    if (queue.length >= maxPlayers) {
        const stateRef = handler === cq1h ? cq1 : handler === cq2h ? cq2 : handler === cq3h ? cq3 : cq4;
        clearInterval(stateRef.timer); stateRef.timer = null;
        const group   = queue.splice(0, maxPlayers);
        const players = group.map(s => s.playerName);
        const code    = makeRoomCode();
        setupRoom(code, players, group, maxPlayers);
        group.forEach(s => s.emit(foundEvent, code));
        kickoffGame(code);
    } else {
        handler.startTimer();
    }
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

    // COIN MATCHMAKING (4P — 1000)
    socket.on('joinCoinMatch',  ({ playerName }) => { socket.playerName = playerName; handleJoinCoinQueue(coinQueue,  cq1h, socket, 'coinMatchFound',  4); });
    socket.on('leaveCoinMatch', () => {
        coinQueue.splice(coinQueue.findIndex(s => s.id === socket.id), 1).length;
        coinQueue = coinQueue.filter(s => s.id !== socket.id);
        if (coinQueue.length === 0 && cq1.timer) { clearInterval(cq1.timer); cq1.timer = null; cq1.timeLeft = COIN_WAIT_SECONDS; }
        cq1h.broadcast(cq1.timeLeft);
    });

    // COIN MATCHMAKING (2P — 2000)
    socket.on('joinCoinMatch2',  ({ playerName }) => { socket.playerName = playerName; handleJoinCoinQueue(coinQueue2, cq2h, socket, 'coinMatch2Found', 2); });
    socket.on('leaveCoinMatch2', () => {
        coinQueue2 = coinQueue2.filter(s => s.id !== socket.id);
        if (coinQueue2.length === 0 && cq2.timer) { clearInterval(cq2.timer); cq2.timer = null; cq2.timeLeft = COIN_WAIT_SECONDS; }
        cq2h.broadcast(cq2.timeLeft);
    });

    // COIN MATCHMAKING (4P — 800)
    socket.on('joinCoinMatch3',  ({ playerName }) => { socket.playerName = playerName; handleJoinCoinQueue(coinQueue3, cq3h, socket, 'coinMatch3Found', 4); });
    socket.on('leaveCoinMatch3', () => {
        coinQueue3 = coinQueue3.filter(s => s.id !== socket.id);
        if (coinQueue3.length === 0 && cq3.timer) { clearInterval(cq3.timer); cq3.timer = null; cq3.timeLeft = COIN_WAIT_SECONDS; }
        cq3h.broadcast(cq3.timeLeft);
    });

    // COIN MATCHMAKING (4P — 1600)
    socket.on('joinCoinMatch4',  ({ playerName }) => { socket.playerName = playerName; handleJoinCoinQueue(coinQueue4, cq4h, socket, 'coinMatch4Found', 4); });
    socket.on('leaveCoinMatch4', () => {
        coinQueue4 = coinQueue4.filter(s => s.id !== socket.id);
        if (coinQueue4.length === 0 && cq4.timer) { clearInterval(cq4.timer); cq4.timer = null; cq4.timeLeft = COIN_WAIT_SECONDS; }
        cq4h.broadcast(cq4.timeLeft);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('disconnected:', socket.id);
        matchQueue  = matchQueue.filter(s => s.id !== socket.id);
        coinQueue   = coinQueue.filter(s => s.id !== socket.id);
        coinQueue2  = coinQueue2.filter(s => s.id !== socket.id);
        coinQueue3  = coinQueue3.filter(s => s.id !== socket.id);
        coinQueue4  = coinQueue4.filter(s => s.id !== socket.id);
        if (matchQueue.length  === 0 && matchTimer)  { clearInterval(matchTimer);  matchTimer  = null; }
        if (coinQueue.length   === 0 && cq1.timer)   { clearInterval(cq1.timer);   cq1.timer   = null; cq1.timeLeft = COIN_WAIT_SECONDS; }
        if (coinQueue2.length  === 0 && cq2.timer)   { clearInterval(cq2.timer);   cq2.timer   = null; cq2.timeLeft = COIN_WAIT_SECONDS; }
        if (coinQueue3.length  === 0 && cq3.timer)   { clearInterval(cq3.timer);   cq3.timer   = null; cq3.timeLeft = COIN_WAIT_SECONDS; }
        if (coinQueue4.length  === 0 && cq4.timer)   { clearInterval(cq4.timer);   cq4.timer   = null; cq4.timeLeft = COIN_WAIT_SECONDS; }
        leaveRoom(socket);
    });
});

server.listen(PORT, () => console.log('Server listening on port ' + PORT));