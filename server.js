const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Configure Socket.IO with enhanced settings
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  upgrade: false,
  pingTimeout: 30000,
  pingInterval: 5000,
  maxHttpBufferSize: 1e8 // 100MB max payload size for file transfers
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store application state
const state = {
  users: {},
  rooms: {
    'general': { users: {}, userCount: 0 },
    'gaming': { users: {}, userCount: 0 },
    'random': { users: {}, userCount: 0 }
  },
  voiceParticipants: {},
  videoParticipants: {},
  roomInfo: {
    'general': { name: 'General', description: 'General discussions', icon: 'fa-hashtag' },
    'gaming': { name: 'Gaming', description: 'All about games', icon: 'fa-gamepad' },
    'random': { name: 'Random', description: 'Anything goes', icon: 'fa-random' }
  }
};

// Helper functions
function updateRoomUserCount(roomId) {
  state.rooms[roomId].userCount = Object.keys(state.rooms[roomId].users).length;
  return state.rooms[roomId].userCount;
}

function broadcastUserList(roomId) {
  const usersInRoom = Object.values(state.rooms[roomId].users);
  
  io.to(roomId).emit('updateUsers', {
    users: usersInRoom.map(u => ({
      username: u.username,
      status: u.status,
      avatarColor: u.avatarColor
    })),
    count: state.rooms[roomId].userCount,
    room: roomId
  });
}

function cleanupUser(socketId) {
  const user = state.users[socketId];
  if (!user) return;

  // Remove from room
  if (state.rooms[user.room]) {
    delete state.rooms[user.room].users[socketId];
    updateRoomUserCount(user.room);
    broadcastUserList(user.room);
  }

  // Remove from voice chat if active
  if (state.voiceParticipants[socketId]) {
    const voiceRoom = state.voiceParticipants[socketId].room;
    delete state.voiceParticipants[socketId];
    io.to(voiceRoom).emit('voiceUserLeft', socketId);
  }

  // Remove from video chat if active
  if (state.videoParticipants[socketId]) {
    const videoRoom = state.videoParticipants[socketId].room;
    delete state.videoParticipants[socketId];
    io.to(videoRoom).emit('videoUserLeft', socketId);
  }

  // Remove from main users list
  delete state.users[socketId];
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Join room handler
  socket.on('join', (data, callback) => {
    try {
      const { username, room, avatarColor } = data;
      
      // Validate input
      if (!username || !room || !state.rooms[room]) {
        throw new Error('Invalid join data');
      }

      // Cleanup previous session if reconnecting
      if (state.users[socket.id]) {
        cleanupUser(socket.id);
      }

      // Create user object
      state.users[socket.id] = {
        id: socket.id,
        username,
        room,
        avatarColor: avatarColor || '#4361ee',
        status: 'online',
        joinedAt: new Date()
      };

      // Add to room
      state.rooms[room].users[socket.id] = state.users[socket.id];
      updateRoomUserCount(room);

      // Join socket room
      socket.join(room);

      // Notify room
      io.to(room).emit('message', {
        user: 'System',
        text: `${username} has joined ${room}`,
        timestamp: new Date().toISOString(),
        isSystem: true
      });

      // Send room info to the user
      const roomData = {
        ...state.roomInfo[room],
        userCount: state.rooms[room].userCount
      };

      // Send user list to everyone in the room
      broadcastUserList(room);

      // Send success response
      if (callback) {
        callback({
          success: true,
          room: roomData,
          user: state.users[socket.id]
        });
      }

      console.log(`${username} joined ${room}`);
    } catch (error) {
      console.error('Join error:', error);
      if (callback) {
        callback({
          success: false,
          error: error.message
        });
      }
    }
  });

  // Message handler
  socket.on('sendMessage', (data) => {
    try {
      const user = state.users[socket.id];
      if (!user || !data || !data.message) return;

      const messageData = {
        user: user.username,
        text: data.message,
        timestamp: new Date().toISOString(),
        isImage: data.isImage || false,
        isSystem: false,
        isAction: data.isAction || false,
        avatarColor: user.avatarColor
      };

      io.to(user.room).emit('message', messageData);
    } catch (error) {
      console.error('Message send error:', error);
    }
  });

  // Voice chat handlers
  socket.on('joinVoiceChat', (room) => {
    try {
      const user = state.users[socket.id];
      if (!user) return;

      // Add to voice participants
      state.voiceParticipants[socket.id] = {
        id: socket.id,
        username: user.username,
        room,
        isMuted: false,
        isDeafened: false,
        avatarColor: user.avatarColor
      };

      // Notify room
      socket.to(room).emit('voiceUserJoined', state.voiceParticipants[socket.id]);

      // Send current participants to the new user
      const participants = Object.values(state.voiceParticipants)
        .filter(p => p.room === room && p.id !== socket.id);
      
      socket.emit('voiceChatUsers', participants);

      console.log(`${user.username} joined voice chat in ${room}`);
    } catch (error) {
      console.error('Voice chat join error:', error);
    }
  });

  socket.on('leaveVoiceChat', () => {
    try {
      if (!state.voiceParticipants[socket.id]) return;

      const room = state.voiceParticipants[socket.id].room;
      delete state.voiceParticipants[socket.id];

      // Notify room
      socket.to(room).emit('voiceUserLeft', socket.id);

      console.log(`User left voice chat in ${room}`);
    } catch (error) {
      console.error('Voice chat leave error:', error);
    }
  });

  // WebRTC signaling handlers
  socket.on('voiceOffer', ({ target, offer }) => {
    try {
      if (state.voiceParticipants[target]) {
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
      if (state.voiceParticipants[target]) {
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
      if (state.voiceParticipants[target]) {
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
      if (!state.voiceParticipants[socket.id]) return;

      state.voiceParticipants[socket.id].isMuted = isMuted;
      state.voiceParticipants[socket.id].isDeafened = isDeafened;

      // Notify room
      socket.to(state.voiceParticipants[socket.id].room).emit('voiceStateChanged', {
        userId: socket.id,
        isMuted,
        isDeafened
      });
    } catch (error) {
      console.error('Voice state change error:', error);
    }
  });

  // Video chat handlers
  socket.on('joinVideoChat', (room) => {
    try {
      const user = state.users[socket.id];
      if (!user) return;

      // Add to video participants
      state.videoParticipants[socket.id] = {
        id: socket.id,
        username: user.username,
        room,
        avatarColor: user.avatarColor
      };

      // Notify room
      socket.to(room).emit('videoUserJoined', state.videoParticipants[socket.id]);

      // Send current participants to the new user
      const participants = Object.values(state.videoParticipants)
        .filter(p => p.room === room && p.id !== socket.id);
      
      socket.emit('videoChatUsers', participants);

      console.log(`${user.username} joined video chat in ${room}`);
    } catch (error) {
      console.error('Video chat join error:', error);
    }
  });

  socket.on('leaveVideoChat', () => {
    try {
      if (!state.videoParticipants[socket.id]) return;

      const room = state.videoParticipants[socket.id].room;
      delete state.videoParticipants[socket.id];

      // Notify room
      socket.to(room).emit('videoUserLeft', socket.id);

      console.log(`User left video chat in ${room}`);
    } catch (error) {
      console.error('Video chat leave error:', error);
    }
  });

  // Video WebRTC signaling handlers
  socket.on('videoOffer', ({ target, offer }) => {
    try {
      if (state.videoParticipants[target]) {
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
      if (state.videoParticipants[target]) {
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
      if (state.videoParticipants[target]) {
        io.to(target).emit('videoIceCandidate', {
          from: socket.id,
          candidate
        });
      }
    } catch (error) {
      console.error('Video ICE candidate error:', error);
    }
  });

  // User status and info handlers
  socket.on('changeUsername', (newUsername) => {
    try {
      const user = state.users[socket.id];
      if (!user) return;

      const oldUsername = user.username;
      user.username = newUsername;

      // Update in rooms
      if (state.rooms[user.room]) {
        state.rooms[user.room].users[socket.id].username = newUsername;
      }

      // Update in voice chat if active
      if (state.voiceParticipants[socket.id]) {
        state.voiceParticipants[socket.id].username = newUsername;
        socket.to(state.voiceParticipants[socket.id].room).emit('voiceUserUpdated', {
          id: socket.id,
          username: newUsername
        });
      }

      // Update in video chat if active
      if (state.videoParticipants[socket.id]) {
        state.videoParticipants[socket.id].username = newUsername;
        socket.to(state.videoParticipants[socket.id].room).emit('videoUserUpdated', {
          id: socket.id,
          username: newUsername
        });
      }

      // Notify room
      io.to(user.room).emit('userChangedUsername', {
        oldUsername,
        newUsername
      });

      // Update user list
      broadcastUserList(user.room);

      console.log(`${oldUsername} changed username to ${newUsername}`);
    } catch (error) {
      console.error('Username change error:', error);
    }
  });

  socket.on('setStatus', (status) => {
    try {
      const user = state.users[socket.id];
      if (!user || !['online', 'away', 'offline'].includes(status)) return;

      user.status = status;

      // Update in rooms
      if (state.rooms[user.room]) {
        state.rooms[user.room].users[socket.id].status = status;
      }

      // Notify room
      io.to(user.room).emit('userStatusChanged', {
        username: user.username,
        status
      });

      // Update user list
      broadcastUserList(user.room);

      console.log(`${user.username} status changed to ${status}`);
    } catch (error) {
      console.error('Status change error:', error);
    }
  });

  // Typing indicators
  socket.on('typing', () => {
    const user = state.users[socket.id];
    if (user) {
      socket.to(user.room).emit('typing', {
        username: user.username,
        room: user.room
      });
    }
  });

  socket.on('stopTyping', () => {
    const user = state.users[socket.id];
    if (user) {
      socket.to(user.room).emit('stopTyping', user.username);
    }
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    try {
      const user = state.users[socket.id];
      if (!user) return;

      console.log(`${user.username} disconnected`);

      // Notify room
      io.to(user.room).emit('message', {
        user: 'System',
        text: `${user.username} has left`,
        timestamp: new Date().toISOString(),
        isSystem: true
      });

      // Notify status change
      io.to(user.room).emit('userStatusChanged', {
        username: user.username,
        status: 'offline'
      });

      // Cleanup user data
      cleanupUser(socket.id);
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });

  // Error handler
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    users: Object.keys(state.users).length,
    voiceParticipants: Object.keys(state.voiceParticipants).length,
    videoParticipants: Object.keys(state.videoParticipants).length,
    rooms: Object.keys(state.rooms).map(roomId => ({
      id: roomId,
      name: state.roomInfo[roomId]?.name || roomId,
      userCount: state.rooms[roomId].userCount
    }))
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
