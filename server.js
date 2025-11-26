const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active users and rooms
const users = new Map();
const rooms = new Map();
const voiceRooms = new Map();
const videoRooms = new Map();

// Initialize default rooms
rooms.set('general', { name: 'General', description: 'General discussions', users: new Set() });
rooms.set('gaming', { name: 'Gaming', description: 'All about games', users: new Set() });
rooms.set('random', { name: 'Random', description: 'Anything goes', users: new Set() });

// Initialize voice and video rooms
voiceRooms.set('general', new Set());
voiceRooms.set('gaming', new Set());
voiceRooms.set('random', new Set());

videoRooms.set('general', new Set());
videoRooms.set('gaming', new Set());
videoRooms.set('random', new Set());

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (userData) => {
    try {
      const { username, room, avatarColor } = userData;
      
      // Store user info
      users.set(socket.id, {
        id: socket.id,
        username,
        room,
        avatarColor,
        status: 'online'
      });

      // Leave previous room if any
      if (socket.room) {
        socket.leave(socket.room);
        const oldRoom = rooms.get(socket.room);
        if (oldRoom) {
          oldRoom.users.delete(socket.id);
        }
      }

      // Join new room
      socket.join(room);
      socket.room = room;

      const roomData = rooms.get(room);
      if (roomData) {
        roomData.users.add(socket.id);
      }

      // Notify room about new user
      socket.to(room).emit('message', {
        user: 'System',
        text: `${username} joined the room`,
        timestamp: new Date(),
        isSystem: true
      });

      // Send updated user list
      updateRoomUsers(room);
      
      // Send welcome message to the user
      socket.emit('message', {
        user: 'System',
        text: `Welcome to ${roomData?.name || room}, ${username}!`,
        timestamp: new Date(),
        isSystem: true
      });

    } catch (error) {
      console.error('Error in join:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('sendMessage', (messageData) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const message = {
        user: user.username,
        text: messageData.message,
        isImage: messageData.isImage || false,
        isAction: messageData.isAction || false,
        timestamp: new Date(),
        reactions: []
      };

      // Broadcast to room
      io.to(user.room).emit('message', message);

    } catch (error) {
      console.error('Error in sendMessage:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('typing', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.room).emit('typing', { username: user.username });
    }
  });

  socket.on('stopTyping', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.room).emit('stopTyping', { username: user.username });
    }
  });

  socket.on('changeUsername', (newUsername) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const oldUsername = user.username;
      user.username = newUsername;

      // Notify room
      io.to(user.room).emit('userChangedUsername', {
        oldUsername,
        newUsername
      });

      updateRoomUsers(user.room);

    } catch (error) {
      console.error('Error in changeUsername:', error);
      socket.emit('error', { message: 'Failed to change username' });
    }
  });

  socket.on('setStatus', (status) => {
    const user = users.get(socket.id);
    if (user && ['online', 'away', 'offline'].includes(status)) {
      user.status = status;
      updateRoomUsers(user.room);
    }
  });

  socket.on('getUsers', () => {
    const user = users.get(socket.id);
    if (user) {
      updateRoomUsers(user.room);
    }
  });

  // Voice Chat Events
  socket.on('joinVoiceChat', (room) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const voiceRoom = voiceRooms.get(room) || new Set();
      voiceRoom.add(socket.id);
      voiceRooms.set(room, voiceRoom);

      // Get current voice chat participants
      const participants = Array.from(voiceRoom)
        .map(id => {
          const u = users.get(id);
          return u ? { id: u.id, username: u.username, isMuted: false, isDeafened: false } : null;
        })
        .filter(Boolean);

      // Notify existing participants about new user
      socket.to(room).emit('voiceUserJoined', {
        id: socket.id,
        username: user.username,
        isMuted: false,
        isDeafened: false
      });

      // Send current participants to the new user
      socket.emit('voiceChatUsers', participants);

      console.log(`User ${user.username} joined voice chat in room ${room}`);

    } catch (error) {
      console.error('Error in joinVoiceChat:', error);
      socket.emit('error', { message: 'Failed to join voice chat' });
    }
  });

  socket.on('leaveVoiceChat', () => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const voiceRoom = voiceRooms.get(user.room);
      if (voiceRoom) {
        voiceRoom.delete(socket.id);
      }

      // Notify other participants
      socket.to(user.room).emit('voiceUserLeft', socket.id);

      console.log(`User ${user.username} left voice chat`);

    } catch (error) {
      console.error('Error in leaveVoiceChat:', error);
    }
  });

  socket.on('voiceStateChange', (state) => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.room).emit('voiceStateChanged', {
        userId: socket.id,
        isMuted: state.isMuted,
        isDeafened: state.isDeafened
      });
    }
  });

  // WebRTC Signaling for Voice
  socket.on('voiceOffer', (data) => {
    socket.to(data.target).emit('voiceOffer', {
      from: socket.id,
      offer: data.offer
    });
  });

  socket.on('voiceAnswer', (data) => {
    socket.to(data.target).emit('voiceAnswer', {
      from: socket.id,
      answer: data.answer
    });
  });

  socket.on('voiceIceCandidate', (data) => {
    socket.to(data.target).emit('voiceIceCandidate', {
      from: socket.id,
      candidate: data.candidate
    });
  });

  // Video Chat Events
  socket.on('joinVideoChat', (room) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const videoRoom = videoRooms.get(room) || new Set();
      videoRoom.add(socket.id);
      videoRooms.set(room, videoRoom);

      // Notify existing participants about new user
      socket.to(room).emit('videoUserJoined', {
        id: socket.id,
        username: user.username
      });

      console.log(`User ${user.username} joined video chat in room ${room}`);

    } catch (error) {
      console.error('Error in joinVideoChat:', error);
      socket.emit('error', { message: 'Failed to join video chat' });
    }
  });

  socket.on('leaveVideoChat', () => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const videoRoom = videoRooms.get(user.room);
      if (videoRoom) {
        videoRoom.delete(socket.id);
      }

      // Notify other participants
      socket.to(user.room).emit('videoUserLeft', socket.id);

      console.log(`User ${user.username} left video chat`);

    } catch (error) {
      console.error('Error in leaveVideoChat:', error);
    }
  });

  // WebRTC Signaling for Video
  socket.on('videoOffer', (data) => {
    socket.to(data.target).emit('videoOffer', {
      from: socket.id,
      offer: data.offer
    });
  });

  socket.on('videoAnswer', (data) => {
    socket.to(data.target).emit('videoAnswer', {
      from: socket.id,
      answer: data.answer
    });
  });

  socket.on('videoIceCandidate', (data) => {
    socket.to(data.target).emit('videoIceCandidate', {
      from: socket.id,
      candidate: data.candidate
    });
  });

  socket.on('disconnect', () => {
    try {
      const user = users.get(socket.id);
      if (user) {
        // Leave voice chat
        const voiceRoom = voiceRooms.get(user.room);
        if (voiceRoom) {
          voiceRoom.delete(socket.id);
          socket.to(user.room).emit('voiceUserLeft', socket.id);
        }

        // Leave video chat
        const videoRoom = videoRooms.get(user.room);
        if (videoRoom) {
          videoRoom.delete(socket.id);
          socket.to(user.room).emit('videoUserLeft', socket.id);
        }

        // Leave text chat room
        const roomData = rooms.get(user.room);
        if (roomData) {
          roomData.users.delete(socket.id);
          
          // Notify room about user leaving
          socket.to(user.room).emit('message', {
            user: 'System',
            text: `${user.username} left the room`,
            timestamp: new Date(),
            isSystem: true
          });

          updateRoomUsers(user.room);
        }

        users.delete(socket.id);
        console.log('User disconnected:', socket.id);
      }
    } catch (error) {
      console.error('Error in disconnect:', error);
    }
  });

  function updateRoomUsers(room) {
    const roomData = rooms.get(room);
    if (!roomData) return;

    const roomUsers = Array.from(roomData.users)
      .map(id => {
        const user = users.get(id);
        return user ? { 
          username: user.username, 
          status: user.status,
          avatarColor: user.avatarColor
        } : null;
      })
      .filter(Boolean);

    io.to(room).emit('updateUsers', {
      room,
      users: roomUsers,
      count: roomUsers.length
    });
  }
});

// Send room list to clients
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    name: room.name,
    description: room.description,
    userCount: room.users.size
  }));
  res.json(roomList);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Voice and video chat enabled with WebRTC`);
});
