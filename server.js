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
            socket.emit('roomList', Object.entries(rooms).map(([id, roomData]) => ({
                id,
                name: id.charAt(0).toUpperCase() + id.slice(1),
                userCount: Object.keys(roomData.users).length
            })));
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