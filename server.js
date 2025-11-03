// 1. 필요한 라이브러리들을 불러옵니다.
require('dotenv').config(); // .env 파일 로드
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');
const qs = require('querystring');
const hangulRomanization = require('hangul-romanization');
const mongoose = require('mongoose'); // ▼▼▼ [추가됨] mongoose 라이브러리 ▼▼▼

// 2. 기본 서버 설정
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// 3. 정적 파일 제공 설정
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// 4. 환경 변수 불러오기
const DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY;
const DEEPL_API_URL = "https://api-free.deepl.com/v2/translate";
const DATABASE_URI = process.env.DATABASE_URI; // ▼▼▼ [추가됨] MongoDB URI ▼▼▼

// 5. MongoDB 스키마 및 모델 정의
// 5-1. 유저 스키마 (방 안에 저장될 용도)
const UserSchema = new mongoose.Schema({
    _id: String, // socket.id를 _id로 사용
    nickname: String,
    role: String
}, { _id: false });

// 5-2. 룸 스키마
const RoomSchema = new mongoose.Schema({
    // roomId는 MongoDB의 고유 _id를 문자열로 변환하여 사용
    roomName: { type: String, required: true },
    password: { type: String },
    hasPassword: { type: Boolean, default: false },
    roomType: { type: String, enum: ['korean', 'translation'], required: true },

    // users 객체를 Map 타입으로 변경 (Key: socket.id, Value: 유저 정보)
    users: {
        type: Map,
        of: new mongoose.Schema({ nickname: String, role: String }, { _id: false })
    },

    finalText: [String],
    activeBuffer: { type: String, default: '' },
    inactiveBuffer: { type: String, default: '' },
    activeUserId: { type: String, default: null }, // socket.id
    createdAt: { type: Date, default: Date.now },
    translationEnabled: { type: Boolean, default: false },
    lastProcessedBuffer: { type: String, default: '' },
    isTranslating: { type: Boolean, default: false },

    // 경합 조건(Race Condition) 방지를 위한 타임스탬프
    activeBufferLastUpdate: { type: Number, default: 0 },
    inactiveBufferLastUpdate: { type: Number, default: 0 }
});

// 5-3. 룸 모델 생성
const Room = mongoose.model('Room', RoomSchema);


// 6. 헬퍼 함수 (데이터베이스 조회)

// 로비 목록 가져오기 (DB에서)
async function getLobbyRooms() {
    try {
        const roomsFromDB = await Room.find({}, 'roomName hasPassword createdAt roomType users');
        const lobbyRooms = {};

        for (const room of roomsFromDB) {
            const typistCount = Array.from(room.users.values()).filter(u => u.role === 'typist').length;
            const observerCount = Array.from(room.users.values()).filter(u => u.role === 'observer').length;

            lobbyRooms[room._id.toString()] = {
                roomId: room._id.toString(),
                roomName: room.roomName,
                hasPassword: room.hasPassword,
                createdAt: room.createdAt,
                typistCount,
                observerCount,
                roomType: room.roomType
            };
        }
        return lobbyRooms;
    } catch (error) {
        console.error("Error fetching lobby rooms:", error);
        return {};
    }
}

// 방 유저 목록 가져오기 (Mongoose Map에서)
function getRoomUsers(room) {
    if (!room || !room.users) return {};
    const users = {};
    for (const [socketId, user] of room.users.entries()) {
        users[socketId] = { nickname: user.nickname, role: user.role };
    }
    return users;
}

// 방 상태 객체 생성 (Mongoose Document에서)
function getRoomState(room) {
    if (!room) return null;
    return {
        roomName: room.roomName,
        users: getRoomUsers(room),
        finalText: room.finalText,
        activeBuffer: room.activeBuffer,
        inactiveBuffer: room.inactiveBuffer,
        activeUserId: room.activeUserId,
        translationEnabled: room.translationEnabled,
        lastProcessedBuffer: room.lastProcessedBuffer,
        roomType: room.roomType
    };
}

// 번역 로직 함수 (boolean 반환)
async function handleTranslation(room, io, roomId) {
    // '번역' 방이 아니거나, '번역 중'이면 false 반환
    if (!room || room.roomType !== 'translation' || room.isTranslating) return false;

    const currentBuffer = room.activeBuffer.trim();
    const lastChar = currentBuffer.slice(-1);

    if (['.', '!', '?', '~'].includes(lastChar) && currentBuffer !== room.lastProcessedBuffer) {
        const textToTranslate = currentBuffer.substring(room.lastProcessedBuffer.length).trim();

        if (textToTranslate) {
            room.isTranslating = true;
            // ▼▼▼ [수정됨] save() 대신 updateOne() 사용 ▼▼▼
            // (save()는 덮어쓰기 위험이 있으므로, 이 필드만 원자적으로 업데이트)
            await Room.updateOne({ _id: roomId }, { $set: { isTranslating: true } });
            // ▲▲▲ [수정 완료] ▲▲▲
            io.to(roomId).emit('updateRoomState', getRoomState(room)); // 상태 전파

            let sentenceToSend = textToTranslate;
            const placeholders = {};
            let placeholderIndex = 0;

            sentenceToSend = sentenceToSend.replace(/'([^']+)'/g, (match, content) => {
                const key = `__PLACEHOLDER_${placeholderIndex++}__`;
                let romanizedContent = content;
                try {
                    if (content.trim()) romanizedContent = hangulRomanization.convert(content);
                } catch (e) { console.error(`[Romanize Error] Input: "${content}". Error: ${e.message}`); }
                placeholders[key] = romanizedContent;
                return key;
            });

            // 번역 로직은 텍스트 업데이트와 경합하지 않으므로 findOneAndUpdate 불필요
            const roomToUpdate = await Room.findById(roomId);
            if(!roomToUpdate) return false; // 방이 그새 삭제됨

            try {
                if (!DEEPL_AUTH_KEY) throw new Error("DeepL API Key is not configured.");

                const requestData = { text: sentenceToSend, source_lang: 'KO', target_lang: 'EN' };
                const response = await axios({
                    method: 'POST', url: DEEPL_API_URL, data: qs.stringify(requestData),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `DeepL-Auth-Key ${DEEPL_AUTH_KEY}`
                    }
                });
                let translatedText = response.data.translations[0].text;

                for (const key in placeholders) {
                    const regex = new RegExp(key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
                    translatedText = translatedText.replace(regex, placeholders[key]);
                }

                roomToUpdate.finalText.push(`${textToTranslate}\n${translatedText}`);
                roomToUpdate.lastProcessedBuffer = currentBuffer;

            } catch (error) {
                console.error("DeepL API Error:", error.response ? error.response.data : error.message);

                let originalSentenceRestored = sentenceToSend;
                for (const key in placeholders) {
                    const regex = new RegExp(key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
                    originalSentenceRestored = originalSentenceRestored.replace(regex, placeholders[key]);
                }
                roomToUpdate.finalText.push(originalSentenceRestored + '\n(번역 실패)');
                roomToUpdate.lastProcessedBuffer = currentBuffer;

            } finally {
                roomToUpdate.isTranslating = false;
                await roomToUpdate.save(); // 번역 완료 후 상태 저장
                io.to(roomId).emit('updateRoomState', getRoomState(roomToUpdate)); // 최종 상태 전파
                return true; // "방송"을 보냈으므로 true 반환
            }
        }
    }
    
    return false; // 번역을 실행하지 않았으므로 false 반환
}


// 7. Socket.io 이벤트 핸들러 (모두 async로 변경 및 DB 연동)
io.on('connection', (socket) => {

    // 로비 목록 요청 (DB)
    socket.on('requestRoomList', async () => {
        socket.emit('updateRoomList', await getLobbyRooms());
    });

    // 방 생성 (DB)
    socket.on('createRoom', async (data) => {
        const { roomName, nickname, password, roomType } = data;
        if (!roomName || !nickname) return socket.emit('createRoomError', { message: '방 이름과 닉네임을 모두 입력해야 합니다.' });
        if (roomType !== 'korean' && roomType !== 'translation') {
             return socket.emit('createRoomError', { message: '잘못된 방 종류입니다.' });
        }
        if (roomType === 'translation' && !DEEPL_AUTH_KEY) {
            console.error("DeepL Auth Key가 설정되지 않았습니다. .env 파일을 확인하세요.");
            return socket.emit('createRoomError', { message: '번역 기능이 서버에서 설정되지 않았습니다. 관리자에게 문의하세요.' });
        }

        try {
            // 새 Room 객체를 DB에 생성
            const newRoom = new Room({
                roomName,
                password,
                hasPassword: !!password,
                roomType: roomType,
                users: new Map(), // 비어있는 Map으로 시작
                finalText: [],
                activeBuffer: '',
                inactiveBuffer: '',
                activeUserId: null,
                createdAt: new Date(),
                translationEnabled: roomType === 'translation',
                lastProcessedBuffer: '',
                isTranslating: false,
                activeBufferLastUpdate: 0,
                inactiveBufferLastUpdate: 0
            });

            // 저장 후 생성된 고유 _id를 roomId로 사용
            const savedRoom = await newRoom.save();
            const roomId = savedRoom._id.toString();

            socket.emit('roomCreated', { roomId, nickname, role: 'typist' });
            io.emit('updateRoomList', await getLobbyRooms());

        } catch (error) {
            console.error("Error creating room:", error);
            socket.emit('createRoomError', { message: '방 생성 중 오류가 발생했습니다.' });
        }
    });

    // 방 입장 (DB)
    socket.on('enterRoom', async (data) => {
        const { roomId, nickname, role, password } = data;

        // roomId 유효성 검사
        if (!mongoose.Types.ObjectId.isValid(roomId)) {
            return socket.emit('roomError', { message: '방 ID가 올바르지 않습니다. 로비로 돌아가세요.' });
        }

        try {
            const room = await Room.findById(roomId);
            if (!room) return socket.emit('roomError', { message: '존재하지 않거나 삭제된 방입니다. 로비로 돌아가세요.' });
            if (room.hasPassword && room.password !== password) return socket.emit('roomError', { message: '비밀번호가 틀렸습니다.' });

            if (role === 'typist') {
                const typistCount = Array.from(room.users.values()).filter(u => u.role === 'typist').length;
                if (typistCount >= 2) return socket.emit('roomError', { message: '입력자가 꽉 찼습니다. 관전자로 참여하거나 나중에 다시 시도해주세요.' });
            }

            socket.join(roomId);
            socket.currentRoomId = roomId;

            // DB의 room.users Map에 사용자 추가
            room.users.set(socket.id, { nickname, role });

            if (role === 'typist' && !room.activeUserId) {
                room.activeUserId = socket.id;
            }

            // 변경사항 DB에 저장
            await room.save();

            io.to(roomId).emit('updateRoomState', getRoomState(room));
            io.emit('updateRoomList', await getLobbyRooms());

        } catch (error) {
            console.error("Error entering room:", error);
            socket.emit('roomError', { message: '방 입장 중 오류가 발생했습니다.' });
        }
    });

    // ▼▼▼ [수정됨] 텍스트 업데이트 (원자적 연산) ▼▼▼
    socket.on('updateText', async ({ roomId, text, timestamp }) => {
        try {
            if (!timestamp) return;

            // 1. 현재 턴 유저 ID를 먼저 확인
            const roomCheck = await Room.findById(roomId, 'activeUserId');
            if (!roomCheck) return;

            const isMyTurn = roomCheck.activeUserId === socket.id;

            let filter, update;

            if (!isMyTurn) {
                // [비활성 사용자]
                filter = {
                    _id: roomId,
                    // 조건: 받은 타임스탬프가 DB의 타임스탬프보다 커야 함
                    inactiveBufferLastUpdate: { $lt: timestamp } 
                };
                update = {
                    $set: {
                        inactiveBuffer: text,
                        inactiveBufferLastUpdate: timestamp
                    }
                };
            } else {
                // [활성 사용자]
                filter = {
                    _id: roomId,
                    // 조건: 받은 타임스탬프가 DB의 타임스탬프보다 커야 함
                    activeBufferLastUpdate: { $lt: timestamp }
                };
                update = {
                    $set: {
                        activeBuffer: text,
                        activeBufferLastUpdate: timestamp
                    }
                };
            }

            // 2. 원자적 업데이트 실행
            const updatedRoom = await Room.findOneAndUpdate(filter, update, { new: true });

            // 3. 업데이트 결과 확인
            if (!updatedRoom) {
                // 업데이트가 실패함 (즉, 구버전 타임스탬프였음)
                return;
            }

            // 4. 업데이트 성공 시, 후속 작업
            if (isMyTurn) {
                // 번역 로직은 업데이트 성공 후에 호출
                await handleTranslation(updatedRoom, io, roomId);
            }

            // 번역 중이 아닐 때만 상태 전파
            if (!updatedRoom.isTranslating) {
                io.to(roomId).emit('updateRoomState', getRoomState(updatedRoom));
            }

        } catch (error) {
            // (예: 동시에 같은 문서 수정 시) 경합 에러가 날 수 있으나,
            // 다음 socket.io 이벤트가 어차피 최신으로 덮어쓰므로 무시해도 됨.
            if (error.code !== 11000) { // 11000 = Mongoose duplicate key error
                 console.error("Error updating text (atomic):", error.message);
            }
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // 턴 넘기기 (DB)
    socket.on('passTurn', async ({ roomId }) => {
        try {
            // (주의: 턴 넘기기는 텍스트 입력과 경합할 수 있으므로, findById -> save 사용)
            const room = await Room.findById(roomId);
            if (room && room.activeUserId === socket.id) {
                if (room.isTranslating) return;

                // '한글' 방일 때만 텍스트 커밋
                if (room.roomType === 'korean') {
                    const textToCommit = (room.activeBuffer || '').trim();
                    if (textToCommit) {
                        room.finalText.push(textToCommit);
                    }
                }

                const typists = Array.from(room.users.entries()).filter(([, user]) => user.role === 'typist');
                const opponentEntry = typists.find(([id]) => id !== socket.id);

                let previousInactiveBuffer = room.inactiveBuffer || ''; // 임시 저장

                if (opponentEntry) {
                    const opponentId = opponentEntry[0];
                    room.activeUserId = opponentId;
                    room.activeBuffer = previousInactiveBuffer; // 이전 inactive를 active로
                    room.inactiveBuffer = ''; // 이전 active는 비움
                } else {
                    room.activeBuffer = '';
                    room.inactiveBuffer = '';
                }

                room.lastProcessedBuffer = '';
                room.activeBufferLastUpdate = 0;
                room.inactiveBufferLastUpdate = 0;

                await room.save(); // 버퍼 교체 및 상태 저장

                const updateSentByTranslator = await handleTranslation(room, io, roomId);

                if (!updateSentByTranslator) {
                    io.to(roomId).emit('updateRoomState', getRoomState(room));
                }
            }
        } catch (error) {
            console.error("Error passing turn:", error);
        }
    });

    // 내용 초기화 (DB)
    socket.on('clearText', async ({ roomId }) => {
        try {
            // (내용 초기화는 텍스트 입력과 경합할 수 있으므로, findById -> save 사용)
            const room = await Room.findById(roomId);
            if (room) {
                room.finalText = [];
                room.activeBuffer = '';
                room.inactiveBuffer = '';
                room.lastProcessedBuffer = '';
                room.isTranslating = false; 

                room.activeBufferLastUpdate = 0;
                room.inactiveBufferLastUpdate = 0;

                await room.save();
                io.to(roomId).emit('updateRoomState', getRoomState(room));
            }
        } catch (error) {
            console.error("Error clearing text:", error);
        }
    });

    // 번역 토글 (DB) - 로직 유지
    socket.on('toggleTranslation', async ({ roomId }) => {
        try {
            const room = await Room.findById(roomId);
            if (!room || room.roomType !== 'translation' || room.isTranslating) return;
            room.translationEnabled = !room.translationEnabled;
            room.lastProcessedBuffer = '';

            await room.save();
            io.to(roomId).emit('updateRoomState', getRoomState(room));
        } catch (error) {
            console.error("Error toggling translation:", error);
        }
    });

    // 상대 첫 단어 삭제 (DB) - 로직 유지
    socket.on('deleteOpponentFirstWord', async ({ roomId }) => {
        try {
            // (F8은 텍스트 입력과 경합할 수 있으므로, findById -> save 사용)
            const room = await Room.findById(roomId);
            if (room && room.activeUserId === socket.id) {

                const typists = Array.from(room.users.entries()).filter(([, user]) => user.role === 'typist');
                const opponentEntry = typists.find(([id]) => id !== socket.id);
                if (!opponentEntry) return;

                const opponentId = opponentEntry[0];
                const opponentText = room.inactiveBuffer || '';
                const trimmedText = opponentText.trimStart();
                const firstSpace = trimmedText.indexOf(' ');
                const firstNewline = trimmedText.indexOf('\n');
                let newText = "";

                if (firstSpace !== -1 || firstNewline !== -1) {
                    let separatorIndex = Math.min(
                        firstSpace === -1 ? Infinity : firstSpace,
                        firstNewline === -1 ? Infinity : firstNewline
                    );
                    newText = trimmedText.substring(separatorIndex + 1).trimStart();
                }
                room.inactiveBuffer = newText;
                
                room.inactiveBufferLastUpdate = Date.now();

                await room.save();

                io.to(opponentId).emit('forceUpdateBuffer', { text: newText });
                io.to(roomId).emit('updateRoomState', getRoomState(room));
            }
        } catch (error) {
            console.error("Error deleting opponent's first word:", error);
        }
    });

    // 방 삭제 이벤트 핸들러 - 로직 유지
    socket.on('deleteRoom', async ({ roomId }) => {
        try {
            if (!mongoose.Types.ObjectId.isValid(roomId)) {
                return socket.emit('deleteRoomError', { message: '잘못된 방 ID입니다.' });
            }

            const room = await Room.findById(roomId);
            if (!room) {
                return socket.emit('deleteRoomError', { message: '이미 삭제되었거나 존재하지 않는 방입니다.' });
            }

            io.to(roomId).emit('roomDeleted', { message: '방 관리자에 의해 이 방이 삭제되었습니다. 로비로 이동합니다.' });
            io.in(roomId).socketsLeave(roomId);
            await Room.findByIdAndDelete(roomId);
            io.emit('updateRoomList', await getLobbyRooms());

        } catch (error) {
            console.error("Error deleting room:", error);
            socket.emit('deleteRoomError', { message: '방 삭제 중 서버 오류가 발생했습니다.' });
        }
    });

    // 연결 끊기 (DB) - 로직 유지
    socket.on('disconnect', async () => {
        const roomId = socket.currentRoomId;
        if (!roomId) return;

        try {
            const room = await Room.findById(roomId);
            if (room) {
                const wasActive = room.activeUserId === socket.id;
                room.users.delete(socket.id);

                if (wasActive) {
                    const remainingTypists = Array.from(room.users.entries()).filter(([, user]) => user.role === 'typist');
                    room.activeUserId = remainingTypists.length > 0 ? remainingTypists[0][0] : null;
                }

                await room.save();

                if (room.users.size > 0) {
                    io.to(roomId).emit('updateRoomState', getRoomState(room));
                }

                io.emit('updateRoomList', await getLobbyRooms());
            }
        } catch (error) {
            console.error("Error during disconnect:", error);
        }
    });
});
// ▲▲▲ [수정 완료] ▲▲▲


// 8. MongoDB 연결 및 서버 시작 (사용자 초기화 로직 추가)
async function startServer() {
    try {
        if (!DATABASE_URI) {
            throw new Error("DATABASE_URI가 .env 파일에 설정되지 않았습니다!");
        }
        await mongoose.connect(DATABASE_URI);
        console.log("MongoDB Atlas에 성공적으로 연결되었습니다.");

        console.log("모든 방의 사용자 목록을 초기화하는 중...");
        const updateResult = await Room.updateMany(
            {}, // 모든 문서를 대상으로
            {
                $set: {
                    users: new Map(), // users 맵을 비움
                    activeUserId: null, // activeUserId 초기화
                    // 서버 재시작 시 타임스탬프 초기화
                    activeBufferLastUpdate: 0,
                    inactiveBufferLastUpdate: 0
                }
            }
        );
        console.log(`초기화 완료: ${updateResult.modifiedCount}개의 방이 업데이트되었습니다.`);

        server.listen(PORT, () => {
            console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
        });

    } catch (error) {
        console.error("서버 시작 또는 MongoDB 연결 실패:", error.message);
        process.exit(1); // 오류 발생 시 서버 종료
    }
}

startServer();