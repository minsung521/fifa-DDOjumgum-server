const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const DEFAULT_GAME_ID = 'fc-online';
const roomName = (gameId) => `game:${gameId}`;

// 게임별 상태를 분리 저장 (지금은 fc-online 하나만 쓰지만
// 나중에 다른 게임 추가 시 이 구조를 그대로 활용)
const gameStates = {
  [DEFAULT_GAME_ID]: {
    status: {
      state: 'checking', // 'online' | 'checking' | 'scheduled'
      endTime: Date.now() + 1000 * 60 * 60 * 2,
    },
    connectedUsers: 0,
  },
};

function getGameState(gameId) {
  if (!gameStates[gameId]) {
    gameStates[gameId] = {
      status: { state: 'checking', endTime: Date.now() + 1000 * 60 * 60 * 2 },
      connectedUsers: 0,
    };
  }
  return gameStates[gameId];
}

const ADMIN_KEY = process.env.ADMIN_KEY || 'temp-admin-key-1234';

app.get('/', (req, res) => {
  res.send('피파또점검이네 서버 살아있음');
});

// 작업 C(콜드스타트 방지)에서 쓸 헬스체크, 미리 추가해둠
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 관리자용 상태 변경 API
app.post('/admin/status', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: '인증 실패' });
  }

  const { state, endTime, gameId = DEFAULT_GAME_ID } = req.body;
  const validStates = ['online', 'checking', 'scheduled'];
  if (!validStates.includes(state)) {
    return res.status(400).json({ error: 'state 값이 올바르지 않습니다' });
  }

  const game = getGameState(gameId);
  game.status = {
    state,
    endTime: endTime || game.status.endTime,
  };

  io.to(roomName(gameId)).emit('status:update', { gameId, ...game.status });
  console.log(`[상태 변경] gameId=${gameId}`, game.status);
  res.json({ success: true, gameId, status: game.status });
});

io.on('connection', (socket) => {
  const gameId = socket.handshake.query.gameId || DEFAULT_GAME_ID;
  const room = roomName(gameId);
  socket.data.gameId = gameId;
  socket.join(room);

  const game = getGameState(gameId);
  game.connectedUsers++;

  console.log(`[연결] 소켓 ID: ${socket.id}, gameId=${gameId}, 현재 접속자: ${game.connectedUsers}`);

  socket.emit('status:update', { gameId, ...game.status });
  io.to(room).emit('users:count', { gameId, count: game.connectedUsers });

  socket.on('chat:message', (payload) => {
    io.to(room).emit('chat:message', {
      gameId,
      nickname: payload.nickname,
      message: payload.message,
      timestamp: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    game.connectedUsers--;
    console.log(`[연결 종료] 소켓 ID: ${socket.id}, gameId=${gameId}, 현재 접속자: ${game.connectedUsers}`);
    io.to(room).emit('users:count', { gameId, count: game.connectedUsers });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);
});