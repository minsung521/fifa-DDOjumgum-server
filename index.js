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

// ============================================================
// Apps Script 이벤트 로깅
// ============================================================

const APPS_SCRIPT_WEBHOOK_URL =
  process.env.APPS_SCRIPT_WEBHOOK_URL;

function logEvent(eventType, gameId, payload = {}) {
  if (!APPS_SCRIPT_WEBHOOK_URL) return;

  fetch(APPS_SCRIPT_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      eventType,
      gameId,
      payload,
    }),
  }).catch((err) => {
    // 로깅 실패가 게임 서버 동작에 영향을 주면 안 됨
    console.error('[logEvent] 로깅 실패:', err.message);
  });
}


// ============================================================
// 게임 설정
// ============================================================

const DEFAULT_GAME_ID = 'fc-online';

const roomName = (gameId) => `game:${gameId}`;


// ============================================================
// 게임별 상태
// ============================================================

const gameStates = {
  [DEFAULT_GAME_ID]: {
    status: {
      state: 'checking',
      endTime: Date.now() + 1000 * 60 * 60 * 2,
    },
    connectedUsers: 0,
  },
};


function getGameState(gameId) {
  if (!gameStates[gameId]) {
    gameStates[gameId] = {
      status: {
        state: 'checking',
        endTime: Date.now() + 1000 * 60 * 60 * 2,
      },
      connectedUsers: 0,
    };
  }

  return gameStates[gameId];
}


// ============================================================
// 관리자 인증
// ============================================================

const ADMIN_KEY =
  process.env.ADMIN_KEY || 'temp-admin-key-1234';


// ============================================================
// 기본 / Health
// ============================================================

app.get('/', (req, res) => {
  res.send('피파또점검이네 서버 살아있음');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
  });
});


// ============================================================
// 관리자용 상태 변경 API
// ============================================================

app.post('/admin/status', (req, res) => {
  const key = req.headers['x-admin-key'];

  if (key !== ADMIN_KEY) {
    return res.status(401).json({
      error: '인증 실패',
    });
  }

  const {
    state,
    endTime,
    gameId = DEFAULT_GAME_ID,
  } = req.body;

  const validStates = [
    'online',
    'checking',
    'scheduled',
  ];

  if (!validStates.includes(state)) {
    return res.status(400).json({
      error: 'state 값이 올바르지 않습니다',
    });
  }

  const game = getGameState(gameId);

  game.status = {
    state,
    endTime: endTime || game.status.endTime,
  };

  // 클라이언트에게 상태 변경 전달
  io.to(roomName(gameId)).emit(
    'status:update',
    {
      gameId,
      ...game.status,
    }
  );

  console.log(
    `[상태 변경] gameId=${gameId}`,
    game.status
  );

  // Apps Script 로그
  logEvent('status:update', gameId, {
    state: game.status.state,
    endTime: game.status.endTime,
  });

  return res.json({
    success: true,
    gameId,
    status: game.status,
  });
});


// ============================================================
// Socket.IO
// ============================================================

io.on('connection', (socket) => {
  const gameId =
    socket.handshake.query.gameId ||
    DEFAULT_GAME_ID;

  const room = roomName(gameId);

  socket.data.gameId = gameId;

  socket.join(room);

  const game = getGameState(gameId);

  // 접속자 수 증가
  game.connectedUsers++;

  console.log(
    `[연결] 소켓 ID: ${socket.id}, gameId=${gameId}, 현재 접속자: ${game.connectedUsers}`
  );

  // 현재 상태 전달
  socket.emit(
    'status:update',
    {
      gameId,
      ...game.status,
    }
  );

  // 접속자 수 변경 전달
  io.to(room).emit(
    'users:count',
    {
      gameId,
      count: game.connectedUsers,
    }
  );

  // Apps Script 로그
  logEvent('socket:connect', gameId, {
    count: game.connectedUsers,
  });

  logEvent('users:count', gameId, {
    count: game.connectedUsers,
  });


  // ==========================================================
  // 채팅
  // ==========================================================

  // 닉네임 제출(입장) 전용 이벤트 — 채팅 참여 시점을 명시적으로 확정
  socket.on('chat:join', (payload) => {
    const nickname =
      typeof payload?.nickname === 'string'
        ? payload.nickname.trim()
        : '';

    if (!nickname || socket.data.nickname) return;

    socket.data.nickname = nickname;

    // 본인을 제외한 같은 room 유저에게만 입장 알림
    socket.to(room).emit(
      'user:joined',
      {
        gameId,
        nickname,
      }
    );

    // Apps Script 로그
    logEvent('chat:join', gameId, { nickname });
  });

  socket.on('chat:message', (payload) => {
    const nickname =
      socket.data.nickname ||
      (typeof payload?.nickname === 'string' ? payload.nickname : '');

    const message =
      typeof payload?.message === 'string'
        ? payload.message
        : '';

    io.to(room).emit(
      'chat:message',
      {
        gameId,
        nickname,
        message,
        timestamp: Date.now(),
      }
    );

    // Apps Script 로그
    // 메시지 원문은 저장하지 않고 길이만 기록
    logEvent('chat:message', gameId, {
      nickname,
      messageLength: message.length,
    });
  });


  // ==========================================================
  // 연결 종료
  // ==========================================================

  socket.on('disconnect', () => {
    game.connectedUsers--;

    // 혹시라도 음수가 되는 것을 방지
    if (game.connectedUsers < 0) {
      game.connectedUsers = 0;
    }

    console.log(
      `[연결 종료] 소켓 ID: ${socket.id}, gameId=${gameId}, 현재 접속자: ${game.connectedUsers}`
    );

    // 클라이언트에게 접속자 수 전달
    io.to(room).emit(
      'users:count',
      {
        gameId,
        count: game.connectedUsers,
      }
    );

    // Apps Script 로그
    logEvent('socket:disconnect', gameId, {
      count: game.connectedUsers,
    });

    logEvent('users:count', gameId, {
      count: game.connectedUsers,
    });

    // 닉네임을 설정했던(=실제로 채팅에 참여했던) 유저만 퇴장 알림
    if (socket.data.nickname) {
      socket.to(room).emit(
        'user:left',
        {
          gameId,
          nickname: socket.data.nickname,
        }
      );
    }
  });
});


// ============================================================
// 서버 시작
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);
});