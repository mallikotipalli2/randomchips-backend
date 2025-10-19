const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Production optimizations
const isProduction = process.env.NODE_ENV === 'production';

// Security and performance middleware
if (isProduction) {
  // Compression for better performance
  const compression = require('compression');
  app.use(compression());
  
  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
}

// Trust proxy in production (for Render, Heroku, etc.)
if (isProduction) {
  app.set('trust proxy', 1);
}

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  methods: ["GET", "POST"],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${req.method} ${req.url} - ${req.ip}`);
  next();
});

// Socket.IO setup with production optimizations
const io = socketIo(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// Enhanced metrics and monitoring
let serverMetrics = {
  startTime: new Date(),
  totalConnections: 0,
  currentConnections: 0,
  totalMatches: 0,
  totalMessages: 0,
  totalImages: 0,
  averageSessionDuration: 0,
  peakConnections: 0,
  connectionsByCountry: new Map(),
  errorCount: 0
};

// Connection tracking with session duration
let activeConnections = new Map();
let waitingQueue = [];
let userCount = 0;

// Enhanced rate limiting
const rateLimits = new Map();
const MESSAGE_RATE_LIMIT = 800; // 800ms between messages (more lenient)
const MAX_MESSAGES_PER_MINUTE = 40; // Increased limit
const MAX_REQUESTS_PER_MINUTE = 100;

// Memory management
const MAX_CONNECTIONS_HISTORY = 10000;
const CLEANUP_INTERVAL = 300000; // 5 minutes

// Multer setup with better error handling
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uuidv4()}-${sanitizedName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

// Serve uploaded files with proper headers
app.use('/uploads', express.static('uploads', {
  maxAge: '1d',
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

// Image upload endpoint with enhanced error handling
app.post('/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    serverMetrics.totalImages++;
    
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ 
      success: true, 
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      type: req.file.mimetype
    });
  });
});

// Enhanced health check endpoint
app.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - serverMetrics.startTime) / 1000);
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: uptime,
    environment: process.env.NODE_ENV || 'development',
    metrics: {
      activeConnections: serverMetrics.currentConnections,
      waitingInQueue: waitingQueue.length,
      totalMatches: serverMetrics.totalMatches,
      totalMessages: serverMetrics.totalMessages,
      totalImages: serverMetrics.totalImages,
      peakConnections: serverMetrics.peakConnections,
      errorCount: serverMetrics.errorCount
    },
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
      external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
    },
    version: '2.0.0'
  });
});

// Metrics endpoint for monitoring (consider protecting in production)
app.get('/metrics', (req, res) => {
  if (isProduction && req.get('x-admin-key') !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  res.json({
    ...serverMetrics,
    activeConnections: Array.from(activeConnections.values()).map(conn => ({
      id: conn.id.substring(0, 8) + '...',
      name: conn.name,
      hasPartner: !!conn.partnerId,
      connectedAt: conn.connectedAt,
      duration: Date.now() - conn.connectedAt
    })),
    waitingQueue: waitingQueue.map(user => ({
      id: user.socketId.substring(0, 8) + '...',
      name: user.name,
      waitTime: Date.now() - user.joinedAt
    }))
  });
});

// Enhanced rate limiting
function isRateLimited(socketId, type = 'message') {
  const now = Date.now();
  const userLimits = rateLimits.get(socketId) || { 
    lastMessage: 0, 
    messageCount: 0, 
    requestCount: 0,
    windowStart: now 
  };

  // Reset counters if window has passed (1 minute)
  if (now - userLimits.windowStart > 60000) {
    userLimits.messageCount = 0;
    userLimits.requestCount = 0;
    userLimits.windowStart = now;
  }

  // Check rate limits based on type
  if (type === 'message') {
    if (now - userLimits.lastMessage < MESSAGE_RATE_LIMIT) {
      return true; // Too fast
    }
    if (userLimits.messageCount >= MAX_MESSAGES_PER_MINUTE) {
      return true; // Too many messages
    }
  } else if (type === 'request') {
    if (userLimits.requestCount >= MAX_REQUESTS_PER_MINUTE) {
      return true; // Too many requests
    }
  }

  // Update limits
  userLimits.lastMessage = now;
  if (type === 'message') userLimits.messageCount++;
  if (type === 'request') userLimits.requestCount++;
  rateLimits.set(socketId, userLimits);
  
  return false;
}

// Socket.IO connection handling with enhanced monitoring
io.on('connection', (socket) => {
  try {
    console.log(`? User connected: ${socket.id} from ${socket.handshake.address}`);
    
    // Update metrics
    serverMetrics.totalConnections++;
    serverMetrics.currentConnections++;
    userCount++;
    
    if (serverMetrics.currentConnections > serverMetrics.peakConnections) {
      serverMetrics.peakConnections = serverMetrics.currentConnections;
    }
    
    // Store user info with session tracking
    activeConnections.set(socket.id, {
      id: socket.id,
      name: null,
      partnerId: null,
      connectedAt: new Date(),
      webrtcConnected: false,
      messagesSent: 0,
      messagesReceived: 0,
      ip: socket.handshake.address
    });

    // Join matchmaking queue
    socket.on('join', (data) => {
      try {
        if (isRateLimited(socket.id, 'request')) {
          socket.emit('rate-limited', { message: 'Too many requests' });
          return;
        }

        const { name } = data || {};
        const userName = name && name.trim() ? name.trim().substring(0, 20) : `RandomChip${Math.floor(Math.random() * 1000)}`;
        
        // Update user info
        const userInfo = activeConnections.get(socket.id);
        if (userInfo) {
          userInfo.name = userName;
        }

        // Add to waiting queue with deduplication
        const existingIndex = waitingQueue.findIndex(user => user.socketId === socket.id);
        if (existingIndex !== -1) {
          waitingQueue.splice(existingIndex, 1);
        }

        waitingQueue.push({
          socketId: socket.id,
          name: userName,
          joinedAt: new Date()
        });

        console.log(`?? ${userName} joined queue. Queue length: ${waitingQueue.length}`);
        tryPairUsers();
      } catch (error) {
        console.error('Error in join handler:', error);
        serverMetrics.errorCount++;
      }
    });

    // WebRTC signaling with enhanced error handling
    socket.on('offer', (data) => {
      try {
        const userInfo = activeConnections.get(socket.id);
        if (userInfo && userInfo.partnerId && data.offer) {
          socket.to(userInfo.partnerId).emit('offer', {
            offer: data.offer,
            from: socket.id
          });
        }
      } catch (error) {
        console.error('Error in offer handler:', error);
        serverMetrics.errorCount++;
      }
    });

    socket.on('answer', (data) => {
      try {
        const userInfo = activeConnections.get(socket.id);
        if (userInfo && userInfo.partnerId && data.answer) {
          socket.to(userInfo.partnerId).emit('answer', {
            answer: data.answer,
            from: socket.id
          });
        }
      } catch (error) {
        console.error('Error in answer handler:', error);
        serverMetrics.errorCount++;
      }
    });

    socket.on('ice-candidate', (data) => {
      try {
        const userInfo = activeConnections.get(socket.id);
        if (userInfo && userInfo.partnerId && data.candidate) {
          socket.to(userInfo.partnerId).emit('ice-candidate', {
            candidate: data.candidate,
            from: socket.id
          });
        }
      } catch (error) {
        console.error('Error in ICE candidate handler:', error);
        serverMetrics.errorCount++;
      }
    });

    // Message handling with enhanced validation
    socket.on('message', (data) => {
      try {
        if (isRateLimited(socket.id, 'message')) {
          socket.emit('rate-limited', { message: 'Sending messages too fast' });
          return;
        }

        const userInfo = activeConnections.get(socket.id);
        if (userInfo && userInfo.partnerId && data.text) {
          const messageText = data.text.toString().trim().substring(0, 1000); // Limit message length
          if (messageText) {
            userInfo.messagesSent++;
            serverMetrics.totalMessages++;
            
            const partnerInfo = activeConnections.get(userInfo.partnerId);
            if (partnerInfo) {
              partnerInfo.messagesReceived++;
            }
            
            socket.to(userInfo.partnerId).emit('message', {
              text: messageText,
              from: userInfo.name,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (error) {
        console.error('Error in message handler:', error);
        serverMetrics.errorCount++;
      }
    });

    // Other event handlers with error handling
    socket.on('req-photo', () => {
      try {
        if (isRateLimited(socket.id, 'request')) return;

        const userInfo = activeConnections.get(socket.id);
        if (userInfo && userInfo.partnerId) {
          console.log(`?? Photo request from ${userInfo.name} to partner`);
          socket.to(userInfo.partnerId).emit('req-photo', {
            from: userInfo.name
          });
        }
      } catch (error) {
        console.error('Error in req-photo handler:', error);
        serverMetrics.errorCount++;
      }
    });

    socket.on('leave', () => {
      try {
        handleUserLeave(socket.id);
      } catch (error) {
        console.error('Error in leave handler:', error);
        serverMetrics.errorCount++;
      }
    });

    socket.on('report', () => {
      try {
        console.log(`?? User ${socket.id} reported their partner`);
        handleUserLeave(socket.id, true);
      } catch (error) {
        console.error('Error in report handler:', error);
        serverMetrics.errorCount++;
      }
    });

    socket.on('disconnect', (reason) => {
      try {
        console.log(`? User disconnected: ${socket.id} (${reason})`);
        handleUserLeave(socket.id);
        
        // Update session duration
        const userInfo = activeConnections.get(socket.id);
        if (userInfo) {
          const sessionDuration = Date.now() - userInfo.connectedAt;
          // Update average (simple moving average)
          serverMetrics.averageSessionDuration = 
            (serverMetrics.averageSessionDuration + sessionDuration) / 2;
        }
        
        activeConnections.delete(socket.id);
        rateLimits.delete(socket.id);
        serverMetrics.currentConnections--;
        userCount--;
      } catch (error) {
        console.error('Error in disconnect handler:', error);
        serverMetrics.errorCount++;
      }
    });

  } catch (error) {
    console.error('Error in connection handler:', error);
    serverMetrics.errorCount++;
  }
});

// Enhanced user pairing with better algorithms
function tryPairUsers() {
  try {
    while (waitingQueue.length >= 2) {
      // Advanced shuffling algorithm
      for (let i = waitingQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [waitingQueue[i], waitingQueue[j]] = [waitingQueue[j], waitingQueue[i]];
      }

      const user1 = waitingQueue.shift();
      const user2 = waitingQueue.shift();

      // Verify both sockets still exist and are valid
      const socket1 = io.sockets.sockets.get(user1.socketId);
      const socket2 = io.sockets.sockets.get(user2.socketId);

      if (!socket1 || !socket2) {
        if (socket1) waitingQueue.unshift(user1);
        if (socket2) waitingQueue.unshift(user2);
        continue;
      }

      // Pair the users
      const userInfo1 = activeConnections.get(user1.socketId);
      const userInfo2 = activeConnections.get(user2.socketId);

      if (userInfo1 && userInfo2) {
        userInfo1.partnerId = user2.socketId;
        userInfo2.partnerId = user1.socketId;

        const roomId = `${Math.min(user1.socketId, user2.socketId)}-${Math.max(user1.socketId, user2.socketId)}`;

        // Notify both users
        socket1.emit('matched', {
          partnerId: user2.socketId,
          partnerName: user2.name,
          roomId: roomId
        });

        socket2.emit('matched', {
          partnerId: user1.socketId,
          partnerName: user1.name,
          roomId: roomId
        });

        serverMetrics.totalMatches++;
        console.log(`?? Paired ${user1.name} with ${user2.name} (Match #${serverMetrics.totalMatches})`);
      }
    }
  } catch (error) {
    console.error('Error in tryPairUsers:', error);
    serverMetrics.errorCount++;
  }
}

// Enhanced user leave handling
function handleUserLeave(socketId, isReport = false) {
  try {
    const userInfo = activeConnections.get(socketId);
    if (!userInfo) return;

    // Remove from queue
    waitingQueue = waitingQueue.filter(user => user.socketId !== socketId);

    // Notify partner
    if (userInfo.partnerId) {
      const partnerInfo = activeConnections.get(userInfo.partnerId);
      if (partnerInfo) {
        partnerInfo.partnerId = null;
        partnerInfo.webrtcConnected = false;
        io.to(userInfo.partnerId).emit('partner-disconnected', {
          reason: isReport ? 'reported' : 'left'
        });
      }
    }

    // Reset user info
    if (userInfo) {
      userInfo.partnerId = null;
      userInfo.webrtcConnected = false;
    }
  } catch (error) {
    console.error('Error in handleUserLeave:', error);
    serverMetrics.errorCount++;
  }
}

// Enhanced cleanup and monitoring
setInterval(() => {
  try {
    const now = new Date();
    const queueTimeout = 120 * 1000; // 2 minutes timeout
    const initialQueueLength = waitingQueue.length;

    // Clean up expired queue entries
    waitingQueue = waitingQueue.filter(user => {
      const isExpired = (now - user.joinedAt) > queueTimeout;
      if (isExpired) {
        const socket = io.sockets.sockets.get(user.socketId);
        if (socket) {
          socket.emit('queue-timeout');
        }
      }
      return !isExpired;
    });

    // Clean up rate limits for disconnected users
    const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
    for (const [socketId] of rateLimits) {
      if (!connectedSocketIds.has(socketId)) {
        rateLimits.delete(socketId);
      }
    }

    // Memory cleanup
    if (activeConnections.size > MAX_CONNECTIONS_HISTORY) {
      console.log('?? Performing memory cleanup...');
      // Keep only recent connections
      const sortedConnections = Array.from(activeConnections.entries())
        .sort((a, b) => b[1].connectedAt - a[1].connectedAt)
        .slice(0, MAX_CONNECTIONS_HISTORY);
      activeConnections.clear();
      sortedConnections.forEach(([id, info]) => activeConnections.set(id, info));
    }

    if (initialQueueLength !== waitingQueue.length) {
      console.log(`?? Cleaned ${initialQueueLength - waitingQueue.length} expired queue entries`);
    }

    // Log periodic status
    if (serverMetrics.currentConnections > 0) {
      console.log(`?? Status: ${serverMetrics.currentConnections} active, ${waitingQueue.length} waiting, ${serverMetrics.totalMatches} total matches`);
    }

  } catch (error) {
    console.error('Error in cleanup interval:', error);
    serverMetrics.errorCount++;
  }
}, CLEANUP_INTERVAL);

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('\n?? Shutting down server gracefully...');
  
  // Notify all connected users
  io.emit('server-shutdown', { message: 'Server is restarting. Please refresh your page.' });
  
  // Close all connections
  io.close(() => {
    console.log('? All socket connections closed');
    
    server.close(() => {
      console.log('? HTTP server closed');
      console.log(`?? Final stats: ${serverMetrics.totalMatches} total matches, ${serverMetrics.totalMessages} messages`);
      process.exit(0);
    });
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.log('? Forced shutdown');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Error handling
process.on('uncaughtException', (error) => {
  console.error('? Uncaught Exception:', error);
  serverMetrics.errorCount++;
  if (isProduction) {
    gracefulShutdown();
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('? Unhandled Rejection at:', promise, 'reason:', reason);
  serverMetrics.errorCount++;
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`?? RandomChips server v2.0.0 running on port ${PORT}`);
  console.log(`?? Health check: http://localhost:${PORT}/health`);
  console.log(`?? Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`?? CORS origin: ${process.env.CORS_ORIGIN || 'http://localhost:3000'}`);
  console.log(`?? Ready for anonymous chats! Started at ${serverMetrics.startTime.toISOString()}`);
});

// Install compression package for production
if (isProduction) {
  try {
    require('compression');
  } catch (e) {
    console.warn('?? Compression package not found. Install with: npm install compression');
  }
}