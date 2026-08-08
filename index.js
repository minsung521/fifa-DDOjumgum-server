const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*', // MVP 단계라 전체 허용, 나중에 client 주소로 좁힐 예정
    methods: ['GET', 'POST'],
  },
});

// 점검 상태 관리 (MVP: 관리자가 수동으로 바꾸는 걸 흉내내는 메모리 상태)
let serverStatus = {
  state: 'checking', // 'online' | 'checking' | 'scheduled'
  endTime: Date.now() + 1000 * 60 * 60 * 2, // 임시로 2시간 뒤 종료 예정
};

let connectedUsers = 0;

app.get('/', (req, res) => {
  res.send('피파또점검이네 서버 살아있음');
});

io.on('connection', (socket) => {
  connectedUsers++;
  console.log(`[연결] 소켓 ID: ${socket.id}, 현재 접속자: ${connectedUsers}`);

  // 새로 접속한 사람에게 현재 상태 즉시 전송
  socket.emit('status:update', serverStatus);
  io.emit('users:count', connectedUsers);

  socket.on('chat:message', (payload) => {
    // payload: { nickname, message }
    io.emit('chat:message', {
      nickname: payload.nickname,
      message: payload.message,
      timestamp: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    connectedUsers--;
    console.log(
      `[연결 종료] 소켓 ID: ${socket.id}, 현재 접속자: ${connectedUsers}`
    );
    io.emit('users:count', connectedUsers);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);
});
