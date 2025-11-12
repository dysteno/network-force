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

// ▼▼▼ [추가됨] 실시간 처리를 위한 인메모리 방 저장소 ▼▼▼
const activeRooms = new Map();
// ▲▲▲ [추가 완료] ▲▲▲

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
        // ▼▼▼ [수정됨] activeRooms에 없는 방만 DB에서 조회 (효율 증가) ▼▼▼
        const activeRoomIds = Array.from(activeRooms.keys());
        const roomsFromDB = await Room.find(
            { _id: { $nin: activeRoomIds } }, // 활성 방 제외
            'roomName hasPassword createdAt roomType users'
        );
        
        const lobbyRooms = {};

        // 1. 메모리에서 활성 방 정보 가져오기
        for (const [roomId, room] of activeRooms.entries()) {
            const typistCount = Array.from(room.users.values()).filter(u => u.role === 'typist').length;
            const observerCount = Array.from(room.users.values()).filter(u => u.role === 'observer').length;
            
            lobbyRooms[roomId] = {
                roomId: roomId,
                roomName: room.roomName,
                hasPassword: room.hasPassword,
                createdAt: room.createdAt,
                typistCount,
                observerCount,
                roomType: room.roomType
            };
        }

        // 2. DB에서 비활성 방 정보 가져오기
        for (const room of roomsFromDB) {
            const typistCount = Array.from(room.users.values()).filter(u => u.role === 'typist').length;
            const observerCount = Array.from(room.users.values()).filter(u => u.role === 'observer').length;
            const roomId = room._id.toString();

            // (혹시 모를 중복 방지)
            if (!lobbyRooms[roomId]) {
                lobbyRooms[roomId] = {
                    roomId: roomId,
                    roomName: room.roomName,
                    hasPassword: room.hasPassword,
                    createdAt: room.createdAt,
                    typistCount,
                    observerCount,
                    roomType: room.roomType
                };
            }
        }
        // ▲▲▲ [수정 완료] ▲▲▲
        return lobbyRooms;
    } catch (error) {
        console.error("Error fetching lobby rooms:", error);
        return {};
    }
}

// 방 유저 목록 가져오기 (Mongoose Map 또는 일반 Map에서)
function getRoomUsers(room) {
    if (!room || !room.users) return {};
    const users = {};
    for (const [socketId, user] of room.users.entries()) {
        users[socketId] = { nickname: user.nickname, role: user.role };
    }
    return users;
}

// 방 상태 객체 생성 (Mongoose Document 또는 인메모리 객체에서)
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

// ▼▼▼ [수정됨] 번역 로직 함수 (DB 재조회 대신 인메모리 객체 사용) ▼▼▼
async function handleTranslation(room, io, roomId) {
    // '번역' 방이 아니거나, '번역 중'이면 false 반환
    if (!room || room.roomType !== 'translation' || room.isTranslating) return false;

    const currentBuffer = room.activeBuffer.trim();
    const lastChar = currentBuffer.slice(-1);

    if (['.', '!', '?', '~'].includes(lastChar) && currentBuffer !== room.lastProcessedBuffer) {
        const textToTranslate = currentBuffer.substring(room.lastProcessedBuffer.length).trim();

        if (textToTranslate) {
            // 1. 인메모리 객체 상태 변경
            room.isTranslating = true;
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
                
                // 2. 인메모리 객체에 번역 결과 반영
                room.finalText.push(`${textToTranslate}\n${translatedText}`);
                room.lastProcessedBuffer = currentBuffer;

            } catch (error) {
                console.error("DeepL API Error:", error.response ? error.response.data : error.message);

                let originalSentenceRestored = sentenceToSend;
                for (const key in placeholders) {
                    const regex = new RegExp(key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
                    originalSentenceRestored = originalSentenceRestored.replace(regex, placeholders[key]);
                }
                
                // 2. 인메모리 객체에 번역 실패 결과 반영
                room.finalText.push(originalSentenceRestored + '\n(번역 실패)');
                room.lastProcessedBuffer = currentBuffer;

            } finally {
                // 3. 인메모리 객체 상태 변경 및 DB에 '커밋'
                room.isTranslating = false;
                await room.save(); // 번역 완료 후 상태 DB에 저장
                io.to(roomId).emit('updateRoomState', getRoomState(room)); // 최종 상태 전파
                return true; // "방송"을 보냈으므로 true 반환
            }
        }
    }
    
    return false; // 번역을 실행하지 않았으므로 false 반환
}
// ▲▲▲ [수정 완료] ▲▲▲


// 7. Socket.io 이벤트 핸들러 (인메모리 Map 연동)
io.on('connection', (socket) => {

    // 로비 목록 요청 (DB + 인메모리)
    socket.on('requestRoomList', async () => {
        socket.emit('updateRoomList', await getLobbyRooms());
    });

    // 방 생성 (DB)
    socket.on('createRoom', async (data) => {
        // (방 생성은 DB에 즉시 반영)
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
            const newRoom = new Room({
                roomName,
                password,
                hasPassword: !!password,
                roomType: roomType,
                users: new Map(),
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

            const savedRoom = await newRoom.save();
            const roomId = savedRoom._id.toString();

            socket.emit('roomCreated', { roomId, nickname, role: 'typist' });
            io.emit('updateRoomList', await getLobbyRooms());

        } catch (error) {
            console.error("Error creating room:", error);
            socket.emit('createRoomError', { message: '방 생성 중 오류가 발생했습니다.' });
        }
    });

    // ▼▼▼ [수정됨] 방 입장 (DB 조회 후 인메모리 Map에 적재) ▼▼▼
    socket.on('enterRoom', async (data) => {
        const { roomId, nickname, role, password } = data;

        if (!mongoose.Types.ObjectId.isValid(roomId)) {
            return socket.emit('roomError', { message: '방 ID가 올바르지 않습니다. 로비로 돌아가세요.' });
        }

        try {
            // 1. 인메모리에 방이 있는지 확인, 없으면 DB에서 조회
            let room = activeRooms.get(roomId);
            if (!room) {
                console.log(`[Room ${roomId}] DB에서 로드 중...`);
                room = await Room.findById(roomId);
                if (!room) return socket.emit('roomError', { message: '존재하지 않거나 삭제된 방입니다. 로비로 돌아가세요.' });
            }

            // 2. 입장 로직 수행
            if (room.hasPassword && room.password !== password) return socket.emit('roomError', { message: '비밀번호가 틀렸습니다.' });

            if (role === 'typist') {
                const typistCount = Array.from(room.users.values()).filter(u => u.role === 'typist').length;
                if (typistCount >= 2) return socket.emit('roomError', { message: '입력자가 꽉 찼습니다. 관전자로 참여하거나 나중에 다시 시도해주세요.' });
            }

            socket.join(roomId);
            socket.currentRoomId = roomId;

            // 3. 인메모리 객체에 사용자 추가 (DB 저장 X)
            room.users.set(socket.id, { nickname, role });

            if (role === 'typist' && !room.activeUserId) {
                room.activeUserId = socket.id;
            }
            
            // 4. ★★★ 인메모리 Map에 최신 방 정보 저장 ★★★
            activeRooms.set(roomId, room);

            // 5. DB 저장(save) 로직은 여기서 제거 (연결 끊길 때만 저장)
            // await room.save(); // <-- 제거

            io.to(roomId).emit('updateRoomState', getRoomState(room));
            io.emit('updateRoomList', await getLobbyRooms());

        } catch (error) {
            console.error("Error entering room:", error);
            socket.emit('roomError', { message: '방 입장 중 오류가 발생했습니다.' });
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // ▼▼▼ [수정됨] 텍스트 업데이트 (DB 쓰기 -> 인메모리 Map 수정으로 변경) ▼▼▼
    socket.on('updateText', async ({ roomId, text, timestamp }) => {
        try {
            if (!timestamp) return;

            // 1. DB 조회가 아닌 인메모리 Map에서 방을 즉시 가져옵니다.
            const room = activeRooms.get(roomId);
            if (!room) return; // 방이 메모리에 없음 (아직 입장 전)

            // 2. 경합 방지를 위한 타임스탬프 확인 (기존 로직 유지)
            const isMyTurn = room.activeUserId === socket.id;

            if (isMyTurn) {
                // [활성 사용자]
                if (timestamp > room.activeBufferLastUpdate) {
                    room.activeBuffer = text;
                    room.activeBufferLastUpdate = timestamp;
                } else {
                    return; // 구버전 텍스트 무시
                }
            } else {
                // [비활성 사용자]
                if (timestamp > room.inactiveBufferLastUpdate) {
                    room.inactiveBuffer = text;
                    room.inactiveBufferLastUpdate = timestamp;
                } else {
                    return; // 구버전 텍스트 무시
                }
            }

            // 3. ★★★ DB 저장 로직 (findOneAndUpdate) 제거 ★★★
            //    이것이 '글자 씹힘' 현상을 해결하는 핵심입니다.
            
            // 4. 번역 로직 호출 (Project 1 고유 기능 유지)
            //    (번역이 발생하면 handleTranslation 함수 내부에서 DB 저장이 일어남)
            if (isMyTurn) {
                await handleTranslation(room, io, roomId);
            }

            // 5. [핵심 변경] 업데이트된 상태를 '나를 제외한' 다른 사람들에게만 전파합니다.
            if (!room.isTranslating) {
                socket.broadcast.to(roomId).emit('updateRoomState', getRoomState(room));
            }

        } catch (error) {
            console.error("Error updating text (in-memory):", error.message);
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // ▼▼▼ [수정됨] 턴 넘기기 (인메모리 수정 + DB 커밋) ▼▼▼
    socket.on('passTurn', async ({ roomId }) => {
        try {
            // 1. 인메모리 Map에서 방 가져오기
            const room = activeRooms.get(roomId);
            if (room && room.activeUserId === socket.id) {
                if (room.isTranslating) return;

                // 2. 인메모리 객체 수정
                if (room.roomType === 'korean') {
                    const textToCommit = (room.activeBuffer || '').trim();
                    if (textToCommit) {
                        room.finalText.push(textToCommit);
                    }
                }

                const typists = Array.from(room.users.entries()).filter(([, user]) => user.role === 'typist');
                const opponentEntry = typists.find(([id]) => id !== socket.id);

                let previousInactiveBuffer = room.inactiveBuffer || '';

                if (opponentEntry) {
                    const opponentId = opponentEntry[0];
                    room.activeUserId = opponentId;
                    room.activeBuffer = previousInactiveBuffer;
                    room.inactiveBuffer = '';
                } else {
                    room.activeBuffer = '';
                    room.inactiveBuffer = '';
                }

                room.lastProcessedBuffer = '';
                room.activeBufferLastUpdate = 0;
                room.inactiveBufferLastUpdate = 0;

                // 3. ★★★ 변경된 내용을 DB에 '커밋(저장)' ★★★
                await room.save(); 

                // 4. 번역 확인 (번역 시 handleTranslation 내부에서 추가 save 발생)
                const updateSentByTranslator = await handleTranslation(room, io, roomId);

                if (!updateSentByTranslator) {
                    io.to(roomId).emit('updateRoomState', getRoomState(room));
                }
            }
        } catch (error) {
            console.error("Error passing turn:", error);
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // ▼▼▼ [수정됨] 내용 초기화 (인메모리 수정 + DB 커밋) ▼▼▼
    socket.on('clearText', async ({ roomId }) => {
        try {
            // 1. 인메모리 Map에서 방 가져오기
            const room = activeRooms.get(roomId);
            if (room) {
                // 2. 인메모리 객체 수정
                room.finalText = [];
                room.activeBuffer = '';
                room.inactiveBuffer = '';
                room.lastProcessedBuffer = '';
                room.isTranslating = false; 
                room.activeBufferLastUpdate = 0;
                room.inactiveBufferLastUpdate = 0;
                
                // 3. ★★★ 변경된 내용을 DB에 '커밋(저장)' ★★★
                await room.save();
                io.to(roomId).emit('updateRoomState', getRoomState(room));
            }
        } catch (error) {
            console.error("Error clearing text:", error);
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // (번역 토글은 자주 발생하지 않으므로 기존 DB 저장 로직 유지 - 수정됨)
    // ▼▼▼ [수정됨] 번역 토글 (인메모리 수정 + DB 커밋) ▼▼▼
    socket.on('toggleTranslation', async ({ roomId }) => {
        try {
            // 1. 인메모리 Map에서 방 가져오기
            const room = activeRooms.get(roomId);
            if (!room || room.roomType !== 'translation' || room.isTranslating) return;
            
            // 2. 인메모리 객체 수정
            room.translationEnabled = !room.translationEnabled;
            room.lastProcessedBuffer = '';

            // 3. ★★★ 변경된 내용을 DB에 '커밋(저장)' ★★★
            await room.save();
            io.to(roomId).emit('updateRoomState', getRoomState(room));
        } catch (error) {
            console.error("Error toggling translation:", error);
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // ▼▼▼ [수정됨] 상대 첫 단어 삭제 (인메모리 수정 + DB 커밋) ▼▼▼
    socket.on('deleteOpponentFirstWord', async ({ roomId }) => {
        try {
            // 1. 인메모리 Map에서 방 가져오기
            const room = activeRooms.get(roomId);
            if (room && room.activeUserId === socket.id) {

                const typists = Array.from(room.users.entries()).filter(([, user]) => user.role === 'typist');
                const opponentEntry = typists.find(([id]) => id !== socket.id);
                if (!opponentEntry) return;
                
                // 2. 인메모리 객체 수정
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

                // 3. ★★★ 변경된 내용을 DB에 '커밋(저장)' ★★★
                await room.save();

                io.to(opponentId).emit('forceUpdateBuffer', { text: newText });
                io.to(roomId).emit('updateRoomState', getRoomState(room));
            }
        } catch (error) {
            console.error("Error deleting opponent's first word:", error);
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // ▼▼▼ [수정됨] 방 삭제 (DB 삭제 + 인메모리 Map 삭제) ▼▼▼
    socket.on('deleteRoom', async ({ roomId }) => {
        try {
            if (!mongoose.Types.ObjectId.isValid(roomId)) {
                return socket.emit('deleteRoomError', { message: '잘못된 방 ID입니다.' });
            }

            // 1. DB에서 방 삭제
            const room = await Room.findByIdAndDelete(roomId);
            if (!room) {
                // DB에 없으면 인메모리에서도 삭제
                activeRooms.delete(roomId);
                return socket.emit('deleteRoomError', { message: '이미 삭제되었거나 존재하지 않는 방입니다.' });
            }

            // 2. 인메모리 Map에서 방 삭제
            activeRooms.delete(roomId);
            
            // 3. 클라이언트에게 알림
            io.to(roomId).emit('roomDeleted', { message: '방 관리자에 의해 이 방이 삭제되었습니다. 로비로 이동합니다.' });
            io.in(roomId).socketsLeave(roomId);
            
            io.emit('updateRoomList', await getLobbyRooms());

        } catch (error) {
            console.error("Error deleting room:", error);
            socket.emit('deleteRoomError', { message: '방 삭제 중 서버 오류가 발생했습니다.' });
        }
    });
    // ▲▲▲ [수정 완료] ▲▲▲

    // ▼▼▼ [수정됨] 연결 끊기 (인메모리 수정 + DB 커밋 + Map 정리) ▼▼▼
    socket.on('disconnect', async () => {
        const roomId = socket.currentRoomId;
        if (!roomId) return;

        try {
            // 1. 인메모리 Map에서 방 가져오기
            const room = activeRooms.get(roomId);
            if (room) {
                // 2. 인메모리 객체에서 사용자 제거
                const wasActive = room.activeUserId === socket.id;
                room.users.delete(socket.id);

                if (wasActive) {
                    const remainingTypists = Array.from(room.users.entries()).filter(([, user]) => user.role === 'typist');
                    room.activeUserId = remainingTypists.length > 0 ? remainingTypists[0][0] : null;
                }

                // 3. ★★★ 사용자가 0명이면 Map에서 제거, 아니면 DB에 '커밋(저장)' ★★★
                if (room.users.size > 0) {
                    await room.save(); // 마지막 상태 저장
                    io.to(roomId).emit('updateRoomState', getRoomState(room));
                } else {
                    // 방이 비었으므로 인메모리에서 제거 (DB에는 데이터가 남아있음)
                    activeRooms.delete(roomId);
                    console.log(`[Room ${roomId}] 방이 비어 인메모리에서 제거합니다.`);
                }

                io.emit('updateRoomList', await getLobbyRooms());
            }
            // (else: 방이 이미 메모리에 없다면 DB를 굳이 조회/저장할 필요 없음)
            
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

        // (기존 로직 유지)
        console.log("서버 재시작: 모든 방의 사용자 목록을 초기화하는 중...");
        const updateResult = await Room.updateMany(
            {}, // 모든 문서를 대상으로
            {
                $set: {
                    users: new Map(), // users 맵을 비움
                    activeUserId: null, // activeUserId 초기화
                    // 버퍼와 타임스탬프도 초기화 (서버 재시작 시 안전하게)
                    activeBuffer: '',
                    inactiveBuffer: '',
                    activeBufferLastUpdate: 0,
                    inactiveBufferLastUpdate: 0,
                    isTranslating: false // 번역 중 상태 강제 해제
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