const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active users and rooms
const users = {};
const rooms = {
    'general': { users: {} },
    'gaming': { users: {} },
    'random': { users: {} }
};

// Store voice and video chat participants
const voiceParticipants = {};
const videoParticipants = {};

io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);

    socket.on('join', (data) => {
        try {
            const { username, room } = data;
            
            // Validate input
            if (!username || !room || !rooms[room]) {
                console.error('Invalid join data:', data);
                return;
            }

            // If user was in another room, leave it first
            if (users[socket.id]) {
                const prevRoom = users[socket.id].room;
                delete rooms[prevRoom].users[socket.id];
                io.to(prevRoom).emit('message', {
                    user: 'System',
                    text: `${users[socket.id].username} has left`,
                    timestamp: new Date().toISOString()
                });
                updateUsersList(prevRoom);
                
                // Leave voice and video chat if active
                if (voiceParticipants[socket.id]) {
                    delete voiceParticipants[socket.id];
                    socket.to(prevRoom).emit('voiceUserLeft', socket.id);
                }
                if (videoParticipants[socket.id]) {
                    delete videoParticipants[socket.id];
                    socket.to(prevRoom).emit('videoUserLeft', socket.id);
                }
            }

            // Store user info
            users[socket.id] = { 
                username, 
                room, 
                socketId: socket.id,
                status: 'online'
            };
            
            // Join room
            socket.join(room);
            rooms[room].users[socket.id] = users[socket.id];
            
            // Notify room
            io.to(room).emit('message', {
                user: 'System',
                text: `${username} has joined ${room}`,
                timestamp: new Date().toISOString()
            });
            
            // Send updated users list and count
            updateUsersList(room);
            
            // Send room list
            socket.emit('roomList', Object.entries(rooms).map(([id, roomData]) => {
                return {
                    id: id,
                    name: id.charAt(0).toUpperCase() + id.slice(1),
                    userCount: Object.keys(roomData.users).length
                };
            }));
        } catch (error) {
            console.error('Join error:', error);
        }
    });

    socket.on('sendMessage', (data) => {
        try {
            const user = users[socket.id];
            if (!user || !data || !data.message) return;

            io.to(user.room).emit('message', {
                user: user.username,
                text: data.message,
                timestamp: new Date().toISOString(),
                isImage: data.isImage || false,
                isAction: data.isAction || false
            });
        } catch (error) {
            console.error('Message send error:', error);
        }
    });

    // Voice chat events
    socket.on('joinVoiceChat', (room) => {
        try {
            const user = users[socket.id];
            if (!user) return;

            // Store voice participant
            voiceParticipants[socket.id] = {
                id: socket.id,
                username: user.username,
                room,
                isMuted: false,
                isDeafened: false
            };

            // Notify room about new voice participant
            socket.to(room).emit('voiceUserJoined', {
                id: socket.id,
                username: user.username,
                isMuted: false,
                isDeafened: false
            });

            // Send current voice participants to the new user
            const participants = Object.values(voiceParticipants)
                .filter(p => p.room === room && p.id !== socket.id);
            
            socket.emit('voiceChatUsers', participants);
        } catch (error) {
            console.error('Voice chat join error:', error);
        }
    });

    socket.on('leaveVoiceChat', () => {
        try {
            if (!voiceParticipants[socket.id]) return;

            const room = voiceParticipants[socket.id].room;
            delete voiceParticipants[socket.id];

            // Notify room
            socket.to(room).emit('voiceUserLeft', socket.id);
        } catch (error) {
            console.error('Voice chat leave error:', error);
        }
    });

    socket.on('voiceOffer', ({ target, offer }) => {
        try {
            if (voiceParticipants[target]) {
                io.to(target).emit('voiceOffer', {
                    from: socket.id,
                    offer
                });
            }
        } catch (error) {
            console.error('Voice offer error:', error);
        }
    });

    socket.on('voiceAnswer', ({ target, answer }) => {
        try {
            if (voiceParticipants[target]) {
                io.to(target).emit('voiceAnswer', {
                    from: socket.id,
                    answer
                });
            }
        } catch (error) {
            console.error('Voice answer error:', error);
        }
    });

    socket.on('voiceIceCandidate', ({ target, candidate }) => {
        try {
            if (voiceParticipants[target]) {
                io.to(target).emit('voiceIceCandidate', {
                    from: socket.id,
                    candidate
                });
            }
        } catch (error) {
            console.error('Voice ICE candidate error:', error);
        }
    });

    socket.on('voiceStateChange', ({ isMuted, isDeafened }) => {
        try {
            if (!voiceParticipants[socket.id]) return;

            voiceParticipants[socket.id].isMuted = isMuted;
            voiceParticipants[socket.id].isDeafened = isDeafened;

            // Notify room
            socket.to(voiceParticipants[socket.id].room).emit('voiceStateChanged', {
                userId: socket.id,
                isMuted,
                isDeafened
            });
        } catch (error) {
            console.error('Voice state change error:', error);
        }
    });

    // Video chat events
    socket.on('joinVideoChat', (room) => {
        try {
            const user = users[socket.id];
            if (!user) return;

            // Store video participant
            videoParticipants[socket.id] = {
                id: socket.id,
                username: user.username,
                room
            };

            // Notify room about new video participant
            socket.to(room).emit('videoUserJoined', {
                id: socket.id,
                username: user.username
            });

            // Send current video participants to the new user
            const participants = Object.values(videoParticipants)
                .filter(p => p.room === room && p.id !== socket.id);
            
            socket.emit('videoChatUsers', participants);
        } catch (error) {
            console.error('Video chat join error:', error);
        }
    });

    socket.on('leaveVideoChat', () => {
        try {
            if (!videoParticipants[socket.id]) return;

            const room = videoParticipants[socket.id].room;
            delete videoParticipants[socket.id];

            // Notify room
            socket.to(room).emit('videoUserLeft', socket.id);
        } catch (error) {
            console.error('Video chat leave error:', error);
        }
    });

    socket.on('videoOffer', ({ target, offer }) => {
        try {
            if (videoParticipants[target]) {
                io.to(target).emit('videoOffer', {
                    from: socket.id,
                    offer
                });
            }
        } catch (error) {
            console.error('Video offer error:', error);
        }
    });

    socket.on('videoAnswer', ({ target, answer }) => {
        try {
            if (videoParticipants[target]) {
                io.to(target).emit('videoAnswer', {
                    from: socket.id,
                    answer
                });
            }
        } catch (error) {
            console.error('Video answer error:', error);
        }
    });

    socket.on('videoIceCandidate', ({ target, candidate }) => {
        try {
            if (videoParticipants[target]) {
                io.to(target).emit('videoIceCandidate', {
                    from: socket.id,
                    candidate
                });
            }
        } catch (error) {
            console.error('Video ICE candidate error:', error);
        }
    });

    socket.on('typing', (room) => {
        const user = users[socket.id];
        if (user) {
            socket.to(room).emit('typing', {
                username: user.username,
                room
            });
        }
    });

    socket.on('stopTyping', (room) => {
        const user = users[socket.id];
        if (user) {
            socket.to(room).emit('stopTyping', user.username);
        }
    });

    socket.on('changeUsername', (newUsername) => {
        const user = users[socket.id];
        if (user) {
            const oldUsername = user.username;
            user.username = newUsername;
            
            // Notify room
            io.to(user.room).emit('userChangedUsername', {
                oldUsername,
                newUsername
            });
            
            // Update users list
            updateUsersList(user.room);
            
            // Update voice participant if exists
            if (voiceParticipants[socket.id]) {
                voiceParticipants[socket.id].username = newUsername;
                socket.to(user.room).emit('voiceUserUpdated', {
                    id: socket.id,
                    username: newUsername
                });
            }
            
            // Update video participant if exists
            if (videoParticipants[socket.id]) {
                videoParticipants[socket.id].username = newUsername;
                socket.to(user.room).emit('videoUserUpdated', {
                    id: socket.id,
                    username: newUsername
                });
            }
        }
    });

    socket.on('setStatus', (status) => {
        const user = users[socket.id];
        if (user && ['online', 'away', 'offline'].includes(status)) {
            user.status = status;
            
            // Notify room
            io.to(user.room).emit('userStatusChanged', {
                username: user.username,
                status
            });
            
            // Update users list
            updateUsersList(user.room);
        }
    });

    socket.on('disconnect', () => {
        try {
            const user = users[socket.id];
            if (!user) return;

            const { room, username } = user;
            
            // Remove from room
            delete rooms[room].users[socket.id];
            delete users[socket.id];
            
            // Remove from voice chat if active
            if (voiceParticipants[socket.id]) {
                const voiceRoom = voiceParticipants[socket.id].room;
                delete voiceParticipants[socket.id];
                socket.to(voiceRoom).emit('voiceUserLeft', socket.id);
            }
            
            // Remove from video chat if active
            if (videoParticipants[socket.id]) {
                const videoRoom = videoParticipants[socket.id].room;
                delete videoParticipants[socket.id];
                socket.to(videoRoom).emit('videoUserLeft', socket.id);
            }
            
            // Notify room
            io.to(room).emit('message', {
                user: 'System',
                text: `${username} has left`,
                timestamp: new Date().toISOString()
            });
            
            // Update users list
            updateUsersList(room);
            
            // Notify status change
            io.to(room).emit('userStatusChanged', {
                username,
                status: 'offline'
            });
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    });

    function updateUsersList(room) {
        const usersInRoom = Object.values(rooms[room].users);
        const userCount = usersInRoom.length;
        
        io.to(room).emit('updateUsers', {
            users: usersInRoom.map(u => ({
                username: u.username,
                status: u.status
            })),
            count: userCount,
            room: room
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});