const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

// ============================================================
// 관리자 인증 키 — 미설정 시 서버 기동 자체를 막는다 (fail-fast)
// ============================================================

const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error(
    '[FATAL] ADMIN_KEY 환경변수가 설정되지 않았습니다. 서버를 종료합니다.'
  );
  process.exit(1);
}

// ============================================================
// CORS 허용 origin 목록
// ============================================================
// ALLOWED_ORIGINS: 콤마로 구분된 프로덕션(Vercel) 도메인 목록 (예: https://fifa-ddojumgum-client.vercel.app)
// 로컬 개발 편의를 위해 Vite 기본 포트는 항상 허용

const allowedOrigins = [
  ...(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  'http://localhost:5173',
];

const corsOptions = {
  origin: (origin, callback) => {
    // origin이 없는 요청(서버 간 통신, curl, health check 등)은 허용
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS로 차단된 요청입니다'));
    }
  },
  credentials: true,
};

const app = express();

app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: corsOptions,
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

// 예약 관련 Apps Script 웹훅 호출 (action 필드로 분기, 응답을 반환해야 하므로 await 가능한 형태)
async function callReservationWebhook(action, params = {}) {
  if (!APPS_SCRIPT_WEBHOOK_URL) {
    throw new Error('APPS_SCRIPT_WEBHOOK_URL이 설정되어 있지 않습니다');
  }

  const res = await fetch(APPS_SCRIPT_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action,
      ...params,
    }),
  });

  return res.json();
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
    manualOverrideActive: false,
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
      manualOverrideActive: false,
    };
  }

  return gameStates[gameId];
}

// 상태 변경 + 브로드캐스트 + 로깅을 한 곳에서 처리 (수동 API / 예약 등록 / 스케줄러가 공유)
function setGameStatus(gameId, state, endTime) {
  const game = getGameState(gameId);

  game.status = {
    state,
    endTime: endTime || game.status.endTime,
  };

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

  logEvent('status:update', gameId, {
    state: game.status.state,
    endTime: game.status.endTime,
  });

  return game.status;
}


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

  const status = setGameStatus(gameId, state, endTime);

  // 관리자가 직접 상태를 바꾼 경우, 서버 재시작 전까지 자동 스케줄러가 개입하지 않도록 플래그 설정
  game.manualOverrideActive = true;

  return res.json({
    success: true,
    gameId,
    status,
  });
});


// ============================================================
// 관리자용 점검 예약 등록 API (프록시 → Apps Script)
// ============================================================

app.post('/admin/reservation', async (req, res) => {
  const key = req.headers['x-admin-key'];

  if (key !== ADMIN_KEY) {
    return res.status(401).json({
      error: '인증 실패',
    });
  }

  const {
    startAt,
    endAt,
    graceMinutes = 60,
    gameId = DEFAULT_GAME_ID,
  } = req.body;

  if (!startAt || !endAt) {
    return res.status(400).json({
      error: 'startAt, endAt은 필수입니다',
    });
  }

  try {
    const result = await callReservationWebhook('createReservation', {
      gameId,
      startAt,
      endAt,
      graceMinutes,
    });

    if (!result || result.success !== true) {
      console.error('[예약 등록] Apps Script 응답 실패:', result);
      return res.status(502).json({
        error: '예약 등록 실패',
      });
    }

    // 등록 즉시 "점검예정" 전환, 카운트다운 target = startAt
    setGameStatus(gameId, 'scheduled', new Date(startAt).getTime());

    return res.json({
      success: true,
      id: result.id,
    });
  } catch (err) {
    console.error('[예약 등록] 실패:', err.message);
    return res.status(502).json({
      error: '예약 등록 실패',
    });
  }
});


// ============================================================
// 관리자용 상태 조회 API (관리자 페이지 폴링용)
// ============================================================

app.get('/admin/state', async (req, res) => {
  const key = req.headers['x-admin-key'];

  if (key !== ADMIN_KEY) {
    return res.status(401).json({
      error: '인증 실패',
    });
  }

  const gameId = DEFAULT_GAME_ID;
  const game = getGameState(gameId);

  try {
    let activeReservation = null;
    let upcomingReservations = [];

    if (APPS_SCRIPT_WEBHOOK_URL) {
      const result = await callReservationWebhook('listReservations');

      if (result && result.success === true && Array.isArray(result.reservations)) {
        const reservations = result.reservations.filter(
          (r) => r.gameId === gameId
        );

        const active = reservations.find((r) => r.status === 'active');

        if (active) {
          activeReservation = {
            id: active.id,
            startAt: active.startAt,
            endAt: active.endAt,
          };
        }

        upcomingReservations = reservations
          .filter((r) => r.status === 'scheduled')
          .sort(
            (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime()
          )
          .map((r) => ({
            id: r.id,
            startAt: r.startAt,
            endAt: r.endAt,
          }));
      }
    }

    return res.json({
      currentStatus: game.status.state,
      manualOverrideActive: !!game.manualOverrideActive,
      activeReservation,
      upcomingReservations,
    });
  } catch (err) {
    console.error('[GET /admin/state] 실패:', err.message);
    return res.status(500).json({
      error: '서버 에러',
    });
  }
});


// ============================================================
// Socket.IO
// ============================================================

io.on('connection', (socket) => {
  const gameId =
    socket.handshake.query.gameId ||
    DEFAULT_GAME_ID;

  // 유입 채널 구분용 UTM src (dc/femco 등). 값이 없거나 빈 문자열이면 'direct'로 명시 처리
  // (|| 연산자는 값이 falsy할 때 의도치 않게 덮어쓸 수 있으므로 사용하지 않음)
  const rawSrc = socket.handshake.query.src;
  const src =
    rawSrc === undefined || rawSrc === null || rawSrc === ''
      ? 'direct'
      : rawSrc;

  const room = roomName(gameId);

  socket.data.gameId = gameId;
  socket.data.src = src;
  socket.data.connectedAt = Date.now();

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
    src,
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
      src: socket.data.src,
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

    // 채널별 체류 시간 파악용
    const sessionDurationMs = Date.now() - socket.data.connectedAt;

    // Apps Script 로그
    logEvent('socket:disconnect', gameId, {
      count: game.connectedUsers,
      src: socket.data.src,
      sessionDurationMs,
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
// 점검 예약 자동 전환 폴링 스케줄러
// ============================================================

const RESERVATION_POLL_INTERVAL_MS = 30 * 1000;

async function pollReservations() {
  if (!APPS_SCRIPT_WEBHOOK_URL) return;

  const gameId = DEFAULT_GAME_ID;
  const game = getGameState(gameId);

  // 관리자가 수동으로 상태를 바꿔둔 상태라면 서버 재시작 전까지 자동 전환하지 않음
  if (game.manualOverrideActive) return;

  try {
    const result = await callReservationWebhook('listReservations');

    if (!result || result.success !== true || !Array.isArray(result.reservations)) {
      return;
    }

    const reservations = result.reservations.filter((r) => r.gameId === gameId);
    const now = Date.now();

    // scheduled -> active(점검중) 전환: startAt이 지난 예약 중 가장 이른 것 하나만
    const dueToStart = reservations
      .filter((r) => r.status === 'scheduled' && new Date(r.startAt).getTime() <= now)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

    if (dueToStart.length > 0) {
      const target = dueToStart[0];

      setGameStatus(gameId, 'checking', new Date(target.endAt).getTime());

      await callReservationWebhook('updateReservationStatus', {
        id: target.id,
        status: 'active',
      });
    }

    // active -> done(정상 복귀) 전환: endAt + graceMinutes가 지난 예약
    const dueToEnd = reservations.filter((r) => {
      if (r.status !== 'active') return false;

      const graceMinutes = r.graceMinutes != null ? r.graceMinutes : 60;
      const graceMs = graceMinutes * 60 * 1000;

      return now >= new Date(r.endAt).getTime() + graceMs;
    });

    for (const r of dueToEnd) {
      setGameStatus(gameId, 'online');

      await callReservationWebhook('updateReservationStatus', {
        id: r.id,
        status: 'done',
      });
    }
  } catch (err) {
    // Apps Script 응답 지연/실패가 서버 전체에 영향을 주면 안 됨
    console.error('[pollReservations] 실패:', err.message);
  }
}


// ============================================================
// 서버 시작
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);

  pollReservations();
  setInterval(pollReservations, RESERVATION_POLL_INTERVAL_MS);
});