const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json()); // 추가: JSON body 파싱

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let serverStatus = {
  state: 'checking', // 'online' | 'checking' | 'scheduled'
  endTime: Date.now() + 1000 * 60 * 60 * 2,
};

let connectedUsers = 0;

// 관리자 키는 Render 환경변수로 관리 (로컬 테스트용 기본값 포함)
const ADMIN_KEY = process.env.ADMIN_KEY || 'temp-admin-key-1234';

app.get('/', (req, res) => {
  res.send('피파또점검이네 서버 살아있음');
});

// 관리자용 상태 변경 API
app.post('/admin/status', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: '인증 실패' });
  }

  const { state, endTime } = req.body;
  const validStates = ['online', 'checking', 'scheduled'];
  if (!validStates.includes(state)) {
    return res.status(400).json({ error: 'state 값이 올바르지 않습니다' });
  }

  serverStatus = {
    state,
    endTime: endTime || serverStatus.endTime,
  };

  io.emit('status:update', serverStatus); // 전체 접속자에게 즉시 반영
  console.log('[상태 변경]', serverStatus);
  res.json({ success: true, status: serverStatus });
});

io.on('connection', (socket) => {
  connectedUsers++;
  console.log(`[연결] 소켓 ID: ${socket.id}, 현재 접속자: ${connectedUsers}`);

  socket.emit('status:update', serverStatus);
  io.emit('users:count', connectedUsers);

  socket.on('chat:message', (payload) => {
    io.emit('chat:message', {
      nickname: payload.nickname,
      message: payload.message,
      timestamp: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    connectedUsers--;
    console.log(`[연결 종료] 소켓 ID: ${socket.id}, 현재 접속자: ${connectedUsers}`);
    io.emit('users:count', connectedUsers);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);
});