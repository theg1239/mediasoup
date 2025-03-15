"use strict";

const fs = require("fs");
const https = require("https");
const express = require("express");
const cors = require("cors");
const socketIo = require("socket.io");
const mediasoup = require("mediasoup");
const os = require("os");
const path = require("path");
require("dotenv").config();

const app = express();
const LOG_PREFIX = "[MediasoupServer]";

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, "mediasoup-certs1", "privkey.pem")),
  cert: fs.readFileSync(path.join(__dirname, "mediasoup-certs1", "fullchain.pem"))
};

// ------------------------------
// CORS Options
// ------------------------------
const corsOptions = {
  origin: (origin, callback) => {
    console.log(`${LOG_PREFIX} CORS check for origin: ${origin}`);
    const allowedOrigins = [
      "http://localhost:3000",
      process.env.FRONTEND_URL || "*"
    ];
    if (!origin) {
      console.log(`${LOG_PREFIX} No origin provided, allowing by default.`);
      return callback(null, true);
    }
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes("*")) {
      console.log(`${LOG_PREFIX} Origin allowed: ${origin}`);
      callback(null, true);
    } else {
      console.error(`${LOG_PREFIX} Origin not allowed: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// ------------------------------
// Health & Static Endpoints
// ------------------------------
app.get("/health", (req, res) => {
  console.log(`${LOG_PREFIX} Health check requested`);
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.use(express.static("public"));

app.get("/", (req, res) => {
  console.log(`${LOG_PREFIX} Root endpoint requested from ${req.ip}`);
  res.send(`
    <h1>MediaSoup WebRTC Server</h1>
    <p>Server is running</p>
    <p>Environment: ${process.env.NODE_ENV || "development"}</p>
    <p>Workers: ${workers.length}</p>
    <p>Active rooms: ${rooms.size}</p>
    <p>Socket.io is available at: <code>${req.protocol}://${req.get("host")}</code></p>
    <p>Health check endpoint: <code>${req.protocol}://${req.get("host")}/health</code></p>
  `);
});

// ------------------------------
// Create HTTPS Server & Socket.IO Instance
// ------------------------------
const server = https.createServer(sslOptions, app);
const io = socketIo(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
  allowEIO3: true,
  allowUpgrades: true,
  maxHttpBufferSize: 1e8,
  connectTimeout: 30000,
  upgradeTimeout: 30000,
  cookie: {
    name: "io",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 86400000
  }
});

console.log(`${LOG_PREFIX} HTTPS and Socket.IO server initialized`);

// ------------------------------
// Helper: Get Listen IPs for mediasoup
// ------------------------------
function getListenIps() {
  console.log(`${LOG_PREFIX} Determining listen IPs for mediasoup...`);
  const interfaces = os.networkInterfaces();
  console.log(`${LOG_PREFIX} Available network interfaces:`, interfaces);
  const listenIps = [];
  const publicIp = process.env.ANNOUNCED_IP || null;
  listenIps.push({ ip: "0.0.0.0", announcedIp: publicIp });
  console.log(`${LOG_PREFIX} Using listen IP: 0.0.0.0 with announced IP: ${publicIp}`);
  if (!publicIp) {
    console.warn(`${LOG_PREFIX} WARNING: No ANNOUNCED_IP set. Remote clients may have connectivity issues.`);
  }
  return listenIps;
}

// ------------------------------
// Mediasoup Options
// ------------------------------
const mediasoupOptions = {
  worker: {
    rtcMinPort: Number(process.env.RTC_MIN_PORT) || 40000,
    rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 49999,
    logLevel: process.env.LOG_LEVEL || "warn",
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp", "verbose"]
  },
  router: {
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
          "x-google-min-bitrate": 600,
          "x-google-max-bitrate": 3000
        }
      },
      {
        kind: "video",
        mimeType: "video/VP9",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
          "profile-id": 2,
          "x-google-min-bitrate": 600,
          "x-google-max-bitrate": 3000
        }
      },
      {
        kind: "video",
        mimeType: "video/h264",
        clockRate: 90000,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "42e01f",
          "level-asymmetry-allowed": 1,
          "x-google-start-bitrate": 1000,
          "x-google-min-bitrate": 600,
          "x-google-max-bitrate": 3000
        }
      }
    ]
  },
  webRtcTransport: {
    listenIps: getListenIps(),
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
    minimumAvailableOutgoingBitrate: 600000,
    maxSctpMessageSize: 262144,
    maxIncomingBitrate: 1500000
  }
};

console.log(`${LOG_PREFIX} Mediasoup options configured:`, mediasoupOptions);

// ------------------------------
// Global Worker/Room Collections
// ------------------------------
const roomsInCreation = new Map();
let workers = [];
const workerLoadCount = new Map();
const rooms = new Map();
// Add breakout rooms tracking
const breakoutRooms = new Map(); // Maps main room ID to array of breakout room IDs
const breakoutToMainRoom = new Map(); // Maps breakout room ID to main room ID
const adminUsers = new Map(); // Maps user email to boolean (true if admin)

// Helper function to check if a user is an admin
function isAdmin(userEmail) {
  if (!userEmail) return false;
  
  // Check if we've already cached this user's admin status
  if (adminUsers.has(userEmail)) {
    return adminUsers.get(userEmail);
  }
  
  // Parse admin emails from environment variable
  const adminEmails = (process.env.FACETIME_ADMINS || "").split(",").map(email => email.trim().toLowerCase());
  const isUserAdmin = adminEmails.includes(userEmail.toLowerCase());
  
  // Cache the result
  adminUsers.set(userEmail, isUserAdmin);
  
  return isUserAdmin;
}

// ------------------------------
// Create Mediasoup Workers
// ------------------------------
async function createWorkers() {
  console.log(`${LOG_PREFIX} Starting creation of mediasoup workers...`);
  const numWorkers = Number(process.env.NUM_WORKERS) || 1;
  const coreCount = os.cpus().length;
  const count = Math.min(numWorkers, coreCount);
  console.log(`${LOG_PREFIX} Creating ${count} workers (CPU cores: ${coreCount}, Requested: ${numWorkers})`);
  const workerPromises = [];
  for (let i = 0; i < count; i++) {
    console.log(`${LOG_PREFIX} Creating worker ${i}`);
    workerPromises.push(
      mediasoup.createWorker(mediasoupOptions.worker)
        .then((worker) => {
          console.log(`${LOG_PREFIX} Mediasoup Worker ${i} created with PID: ${worker.pid}`);
          worker.on("died", (error) => {
            console.error(`${LOG_PREFIX} Worker ${i} died: ${error.message}`);
            setTimeout(async () => {
              try {
                const newWorker = await mediasoup.createWorker(mediasoupOptions.worker);
                workers[i] = newWorker;
                workerLoadCount.set(newWorker, 0);
                console.log(`${LOG_PREFIX} Worker ${i} recreated with new PID: ${newWorker.pid}`);
              } catch (err) {
                console.error(`${LOG_PREFIX} Failed to recreate worker ${i}:`, err);
              }
            }, 2000);
          });
          workers[i] = worker;
          workerLoadCount.set(worker, 0);
          return worker;
        })
        .catch((error) => {
          console.error(`${LOG_PREFIX} Failed to create worker ${i}:`, error);
          return null;
        })
    );
  }
  const results = await Promise.all(workerPromises);
  workers = results.filter((w) => w !== null);
  if (workers.length === 0) {
    throw new Error(`${LOG_PREFIX} Failed to create any mediasoup workers`);
  }
  console.log(`${LOG_PREFIX} Created ${workers.length} mediasoup workers successfully`);
}

(async () => {
  try {
    await createWorkers();
  } catch (err) {
    console.error(`${LOG_PREFIX} Critical error during worker creation:`, err);
    process.exit(1);
  }
})();

function getLeastLoadedWorker() {
  if (workers.length === 0)
    throw new Error(`${LOG_PREFIX} No mediasoup workers available`);
  const sorted = [...workerLoadCount.entries()].sort((a, b) => a[1] - b[1]);
  const [worker, load] = sorted[0];
  workerLoadCount.set(worker, load + 1);
  console.log(`${LOG_PREFIX} Selected worker PID ${worker.pid} (load: ${load} -> ${load + 1})`);
  return worker;
}

function releaseWorker(worker) {
  const current = workerLoadCount.get(worker) || 0;
  if (current > 0) {
    const newLoad = Math.max(0, current - 0.25); // Decrement by same amount we increment
    workerLoadCount.set(worker, newLoad);
    console.log(`${LOG_PREFIX} Released worker PID ${worker.pid} (new load: ${newLoad})`);
  } else {
    console.warn(`${LOG_PREFIX} Worker PID ${worker.pid} already has load 0`);
  }
}

// ------------------------------
// Room Management
// ------------------------------
async function getOrCreateRoom(roomName) {
  console.log(`${LOG_PREFIX} getOrCreateRoom called for room: ${roomName}`);
  let room = rooms.get(roomName);
  if (room) {
    console.log(`${LOG_PREFIX} Room ${roomName} exists`);
    return room;
  }
  if (roomsInCreation.has(roomName)) {
    console.log(`${LOG_PREFIX} Room ${roomName} is being created, waiting...`);
    await roomsInCreation.get(roomName);
    return rooms.get(roomName);
  }
  const promise = new Promise(async (resolve, reject) => {
    try {
      // Get least loaded worker - we'll reuse workers across rooms
      const worker = getLeastLoadedWorker();
      const router = await worker.createRouter({ mediaCodecs: mediasoupOptions.router.mediaCodecs });
      console.log(`${LOG_PREFIX} Router created for room ${roomName} on worker PID ${worker.pid}`);
      room = {
        id: roomName,
        router,
        worker, // We still track which worker the room is using
        peers: new Map(),
        creationTime: Date.now()
      };
      rooms.set(roomName, room);
      
      // Update worker load count based on number of routers/rooms it handles
      const currentLoad = workerLoadCount.get(worker) || 0;
      workerLoadCount.set(worker, currentLoad + 0.25); // Increment by smaller amount since rooms share workers
      console.log(`${LOG_PREFIX} Updated worker ${worker.pid} load to ${currentLoad + 0.25} after adding room ${roomName}`);
      
      resolve(room);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating room ${roomName}:`, error);
      reject(error);
    } finally {
      roomsInCreation.delete(roomName);
      console.log(`${LOG_PREFIX} Cleanup for room creation of ${roomName}`);
    }
  });
  roomsInCreation.set(roomName, promise);
  return promise;
}

// ------------------------------
// Create WebRTC Transport
// ------------------------------
async function createWebRtcTransport(router) {
  console.log(`${LOG_PREFIX} Creating WebRTC transport on router ${router.id}`);
  const { listenIps, initialAvailableOutgoingBitrate, maxIncomingBitrate } = mediasoupOptions.webRtcTransport;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const errMsg = `${LOG_PREFIX} Timeout creating WebRTC transport`;
      console.error(errMsg);
      reject(new Error(errMsg));
    }, 10000);
    const transportOptions = {
      listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate,
      enableSctp: true,
      numSctpStreams: { OS: 1024, MIS: 1024 },
      maxSctpMessageSize: 262144,
      iceConsentTimeout: 60,
      iceRetransmissionTimeout: 1000,
      additionalSettings: {
        iceTransportPolicy: "all",
        iceCandidatePoolSize: 10,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" },
          { urls: "stun:stun.stunprotocol.org:3478" }
        ]
      }
    };
    router.createWebRtcTransport(transportOptions)
      .then(async (transport) => {
        clearTimeout(timeout);
        console.log(`${LOG_PREFIX} WebRTC transport created: ${transport.id}`);
        if (maxIncomingBitrate) {
          await transport.setMaxIncomingBitrate(maxIncomingBitrate);
          console.log(`${LOG_PREFIX} Set max incoming bitrate to ${maxIncomingBitrate} for ${transport.id}`);
        }
        transport.on("routerclose", () =>
          console.log(`${LOG_PREFIX} Transport ${transport.id} closed (router closed)`)
        );
        transport.on("icestatechange", (state) => {
          console.log(`${LOG_PREFIX} Transport ${transport.id} ICE state: ${state}`);
          if (state === "failed") {
            transport.restartIce()
              .then(() => console.log(`${LOG_PREFIX} ICE restarted for ${transport.id}`))
              .catch((error) => console.error(`${LOG_PREFIX} ICE restart error for ${transport.id}:`, error));
          }
        });
        transport.on("dtlsstatechange", (state) => {
          console.log(`${LOG_PREFIX} Transport ${transport.id} DTLS state: ${state}`);
        });
        transport.on("sctpstatechange", (state) => {
          console.log(`${LOG_PREFIX} Transport ${transport.id} SCTP state: ${state}`);
        });
        resolve({
          transport,
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters
          }
        });
      })
      .catch((error) => {
        clearTimeout(timeout);
        console.error(`${LOG_PREFIX} Error creating WebRTC transport:`, error);
        reject(error);
      });
  });
}

// ------------------------------
// Socket & Room Management
// ------------------------------
io.on("connection", (socket) => {
  console.log(`${LOG_PREFIX} New socket connection: ${socket.id}`);
  socket.data = {};

  // Handle user joining a room
  socket.on("joinRoom", async (data, callback) => {
    try {
      const { roomName, userId, userName, userEmail, mainRoomId } = data;
      console.log(`${LOG_PREFIX} User ${userName} (${userId}) joining room ${roomName}`);
      
      // Check if this is a breakout room join
      const isBreakoutRoom = mainRoomId ? true : false;
      
      // Get or create the room
      const room = await getOrCreateRoom(roomName);
      
      // Check if user is already in the room
      if (room.peers.has(socket.id)) {
        console.log(`${LOG_PREFIX} User ${userName} (${userId}) already in room ${roomName}`);
        // Just update the callback with current state
        callback({
          rtpCapabilities: room.router.rtpCapabilities,
          isAdmin: isAdmin(userEmail),
          isBreakoutRoom,
          mainRoomId
        });
        return;
      }
      
      // Add user to the room
      const peer = {
        socket,
        userId,
        userName,
        userEmail,
        consumers: new Map(),
        producers: new Map(),
        transports: new Map(),
        rtpCapabilities: null,
        joinTime: Date.now(),
        deviceLoaded: false
      };
      
      room.peers.set(socket.id, peer);
      socket.roomName = roomName;
      socket.userId = userId;
      socket.userName = userName;
      
      // Join the socket room
      socket.join(roomName);
      
      // Notify other users in the room
      socket.to(roomName).emit("userJoined", {
        userId,
        userName,
        userInitials: userName.substring(0, 2)
      });
      
      // Get existing producers for the room
      const existingProducers = [];
      for (const [peerId, peer] of room.peers.entries()) {
        if (peerId !== socket.id) {
          for (const [producerId, producer] of peer.producers.entries()) {
            existingProducers.push({
              producerId,
              producerUserId: peer.userId
            });
          }
        }
      }
      
      // Send room info to the client
      callback({
        rtpCapabilities: room.router.rtpCapabilities,
        existingProducers,
        isAdmin: isAdmin(userEmail),
        isBreakoutRoom,
        mainRoomId,
        chatHistory: room.chatHistory || []
      });
      
      console.log(`${LOG_PREFIX} User ${userName} (${userId}) joined room ${roomName}`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error joining room:`, error);
      callback({ error: error.message });
    }
  });

  // Handle user leaving a room
  socket.on("leaveRoom", async (data) => {
    try {
      const { roomName, userId, isMovingToBreakoutRoom, isReturningToMainRoom } = data;
      console.log(`${LOG_PREFIX} User ${socket.userName} (${userId}) leaving room ${roomName}`);
      
      // Special handling for breakout room transitions
      const isTransitioning = isMovingToBreakoutRoom || isReturningToMainRoom;
      
      // Get the room
      const room = rooms.get(roomName);
      if (!room) {
        console.log(`${LOG_PREFIX} Room ${roomName} not found for user leaving`);
        return;
      }
      
      // Get the peer
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.log(`${LOG_PREFIX} Peer not found in room ${roomName}`);
        return;
      }
      
      // Close all transports
      for (const transport of peer.transports.values()) {
        try {
          transport.close();
        } catch (error) {
          console.error(`${LOG_PREFIX} Error closing transport:`, error);
        }
      }
      
      // Remove peer from room
      room.peers.delete(socket.id);
      
      // Leave the socket room
      socket.leave(roomName);
      
      // Notify other users in the room
      if (!isTransitioning) {
        socket.to(roomName).emit("userLeft", { userId });
      }
      
      // Check if room is empty
      if (room.peers.size === 0) {
        // If this is a breakout room, notify the main room
        if (room.isBreakoutRoom && room.mainRoomId) {
          io.to(room.mainRoomId).emit("breakoutRoomEmpty", { breakoutRoomId: roomName });
        }
        
        // Close and cleanup the room if not transitioning
        if (!isTransitioning) {
          await closeAndCleanupRoom(roomName);
        }
      }
      
      console.log(`${LOG_PREFIX} User ${socket.userName} (${userId}) left room ${roomName}`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error leaving room:`, error);
    }
  });

  // Handle screen sharing events
  socket.on("screenShareStarted", (data) => {
    try {
      const { userId, userName, hasCamera } = data;
      const roomName = socket.roomName;
      
      if (!roomName) {
        console.error(`${LOG_PREFIX} No room found for screen share start`);
        return;
      }
      
      console.log(`${LOG_PREFIX} User ${userName} (${userId}) started screen sharing in room ${roomName}`);
      
      // Broadcast to all users in the room except the sender
      socket.to(roomName).emit("screenShareStarted", { userId, userName, hasCamera });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error handling screen share start:`, error);
    }
  });

  socket.on("screenShareStopped", (data) => {
    try {
      const { userId } = data || { userId: socket.userId };
      const roomName = socket.roomName;
      
      if (!roomName) {
        console.error(`${LOG_PREFIX} No room found for screen share stop`);
        return;
      }
      
      console.log(`${LOG_PREFIX} User ${socket.userName} (${userId}) stopped screen sharing in room ${roomName}`);
      
      // Broadcast to all users in the room except the sender
      socket.to(roomName).emit("screenShareStopped", { userId });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error handling screen share stop:`, error);
    }
  });

  // Handle chat messages
  socket.on("chatMessage", (data) => {
    try {
      const { roomId, userId, userName, message, timestamp } = data;
      
      if (!roomId) {
        console.error(`${LOG_PREFIX} No room ID provided for chat message`);
        return;
      }
      
      console.log(`${LOG_PREFIX} Chat message from ${userName} (${userId}) in room ${roomId}: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
      
      // Add the message to the room's chat history if needed
      const room = rooms.get(roomId);
      if (!room) {
        console.error(`${LOG_PREFIX} Room ${roomId} not found for chat message`);
        return;
      }
      
      // Initialize chat history if it doesn't exist
      if (!room.chatHistory) {
        room.chatHistory = [];
      }
      
      // Add message to history (optional, limit to last 100 messages)
      const chatMessage = { userId, userName, message, timestamp };
      room.chatHistory.push(chatMessage);
      if (room.chatHistory.length > 100) {
        room.chatHistory.shift(); // Remove oldest message if over 100
      }
      
      // Broadcast to all users in the room (including sender for consistency)
      io.to(roomId).emit("chatMessage", chatMessage);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error handling chat message:`, error);
    }
  });

  // Handle room users request
  socket.on("getRoomUsers", (data) => {
    try {
      const { roomId } = data;
      
      if (!roomId) {
        console.error(`${LOG_PREFIX} No room ID provided for getRoomUsers`);
        return;
      }
      
      console.log(`${LOG_PREFIX} Getting users for room ${roomId}`);
      
      const room = rooms.get(roomId);
      if (!room) {
        console.error(`${LOG_PREFIX} Room ${roomId} not found for getRoomUsers`);
        return;
      }
      
      // Collect user information
      const users = [];
      for (const [peerId, peer] of room.peers.entries()) {
        users.push({
          userId: peer.userId,
          userName: peer.userName,
          userInitials: peer.userName.substring(0, 2)
        });
      }
      
      // Send to the requesting client
      socket.emit("roomUsers", users);
      
      console.log(`${LOG_PREFIX} Sent ${users.length} users for room ${roomId}`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error handling getRoomUsers:`, error);
    }
  });

  // Handle breakout room creation
  socket.on("createBreakoutRooms", async (data, callback) => {
    try {
      const { count, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail)) {
        callback({ error: "Only admins can create breakout rooms" });
        return;
      }
      
      console.log(`${LOG_PREFIX} Creating ${count} breakout rooms for main room ${mainRoomId}`);
      
      // Get the main room
      const mainRoom = rooms.get(mainRoomId);
      if (!mainRoom) {
        callback({ error: "Main room not found" });
        return;
      }
      
      // Create breakout rooms
      const breakoutRooms = [];
      for (let i = 0; i < count; i++) {
        const breakoutRoomId = `${mainRoomId}-breakout-${i + 1}`;
        
        // Create the breakout room
        const room = await getOrCreateRoom(breakoutRoomId);
        
        // Mark as breakout room
        room.isBreakoutRoom = true;
        room.mainRoomId = mainRoomId;
        
        breakoutRooms.push({
          id: breakoutRoomId,
          name: `Breakout Room ${i + 1}`,
          participants: []
        });
      }
      
      // Store breakout rooms in main room
      mainRoom.breakoutRooms = breakoutRooms;
      
      // Notify all users in the main room
      io.to(mainRoomId).emit("breakoutRoomsCreated", {
        mainRoomId,
        breakoutRooms
      });
      
      callback({ success: true, breakoutRooms });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating breakout rooms:`, error);
      callback({ error: error.message });
    }
  });

  // Handle assigning users to breakout rooms
  socket.on("assignToBreakoutRoom", async (data, callback) => {
    try {
      const { userId, breakoutRoomId, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail)) {
        callback({ error: "Only admins can assign users to breakout rooms" });
        return;
      }
      
      console.log(`${LOG_PREFIX} Assigning user ${userId} to breakout room ${breakoutRoomId}`);
      
      // Get the main room
      const mainRoom = rooms.get(mainRoomId);
      if (!mainRoom) {
        callback({ error: "Main room not found" });
        return;
      }
      
      // Get the breakout room
      const breakoutRoom = rooms.get(breakoutRoomId);
      if (!breakoutRoom) {
        callback({ error: "Breakout room not found" });
        return;
      }
      
      // Find the user's socket in the main room
      let userSocket = null;
      let userName = null;
      
      for (const [peerId, peer] of mainRoom.peers.entries()) {
        if (peer.userId === userId) {
          userSocket = peer.socket;
          userName = peer.userName;
          break;
        }
      }
      
      if (!userSocket) {
        callback({ error: "User not found in main room" });
        return;
      }
      
      // Notify the user to move to the breakout room
      userSocket.emit("moveToBreakoutRoom", {
        breakoutRoomId,
        mainRoomId
      });
      
      // Notify all users in the main room
      io.to(mainRoomId).emit("userAssignedToBreakoutRoom", {
        userId,
        userName,
        breakoutRoomId
      });
      
      callback({ success: true });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error assigning user to breakout room:`, error);
      callback({ error: error.message });
    }
  });

  // Handle returning all users to main room
  socket.on("returnAllToMainRoom", async (data, callback) => {
    try {
      const { mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail)) {
        callback({ error: "Only admins can return users to main room" });
        return;
      }
      
      console.log(`${LOG_PREFIX} Returning all users to main room ${mainRoomId}`);
      
      // Get the main room
      const mainRoom = rooms.get(mainRoomId);
      if (!mainRoom) {
        callback({ error: "Main room not found" });
        return;
      }
      
      // Get all breakout rooms for this main room
      const breakoutRoomIds = [];
      for (const [roomId, room] of rooms.entries()) {
        if (room.isBreakoutRoom && room.mainRoomId === mainRoomId) {
          breakoutRoomIds.push(roomId);
        }
      }
      
      // Notify all users in breakout rooms to return to main room
      for (const breakoutRoomId of breakoutRoomIds) {
        const breakoutRoom = rooms.get(breakoutRoomId);
        if (breakoutRoom) {
          for (const peer of breakoutRoom.peers.values()) {
            peer.socket.emit("returnToMainRoom", { mainRoomId });
          }
        }
      }
      
      callback({ success: true });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error returning users to main room:`, error);
      callback({ error: error.message });
    }
  });

  socket.on("getRouterRtpCapabilities", (data, callback) => {
    const room = rooms.get(socket.roomName);
    if (room) {
      const rtpCaps = (room.router &&
        typeof room.router.rtpCapabilities.toJSON === "function")
        ? room.router.rtpCapabilities.toJSON()
        : room.router.rtpCapabilities;
      callback({ rtpCapabilities: rtpCaps });
    } else {
      callback({ rtpCapabilities: null });
    }
  });

  // transport-connect: acknowledge connection
  socket.on("transport-connect", async (data, callback) => {
    try {
      const room = rooms.get(socket.roomName);
      if (!room) throw new Error("Room not found");
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");
      
      const transport = peer.transports[data.transportId];
      if (!transport) throw new Error("Transport not found");
      
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      safeCallback(callback);
    } catch (error) {
      safeCallback(callback, { error: error.message });
    }
  });

  // transport-produce: create a producer
  socket.on("transport-produce", async (data, callback) => {
    try {
      const room = rooms.get(socket.roomName);
      if (!room) {
        console.error(`${LOG_PREFIX} Room not found for user ${socket.userId}`);
        safeCallback(callback, { error: "Room not found" });
        return;
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`${LOG_PREFIX} Peer not found for user ${socket.userId}`);
        safeCallback(callback, { error: "Peer not found" });
        return;
      }
      
      const transport = peer.transports[data.transportId];
      if (!transport) {
        console.error(`${LOG_PREFIX} Transport not found for user ${socket.userId}`);
        safeCallback(callback, { error: "Transport not found" });
        return;
      }
      
      console.log(`${LOG_PREFIX} Creating producer for user ${socket.userId} with kind ${data.kind}`);
      
      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: data.appData
      });
      
      peer.producers.set(producer.id, producer);
      console.log(`${LOG_PREFIX} Producer created: ${producer.id} for user ${socket.userId}`);
      
      // Notify other users about the new producer
      socket.to(socket.roomName).emit("new-producer", {
        producerId: producer.id,
        producerUserId: socket.userId,
        kind: producer.kind
      });
      
      safeCallback(callback, { id: producer.id });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating producer:`, error);
      safeCallback(callback, { error: error.message });
    }
  });

  // transport-recv-connect: acknowledge consumer transport connection
  socket.on("transport-recv-connect", async (data, callback) => {
    try {
      const room = rooms.get(socket.roomName);
      if (!room) {
        safeCallback(callback, { error: "Room not found" });
        return;
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        safeCallback(callback, { error: "Peer not found" });
        return;
      }
      
      const transport = peer.transports[data.serverConsumerTransportId];
      if (!transport) {
        safeCallback(callback, { error: "Consumer transport not found" });
        return;
      }
      
      console.log(`${LOG_PREFIX} Connecting consumer transport ${data.serverConsumerTransportId} for user ${socket.userId}`);
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      safeCallback(callback);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error connecting consumer transport:`, error);
      safeCallback(callback, { error: error.message });
    }
  });

  // consume: create a consumer for a remote producer
  socket.on("consume", async (data, callback) => {
    try {
      const room = rooms.get(socket.roomName);
      if (!room) {
        safeCallback(callback, { error: "Room not found" });
        return;
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        safeCallback(callback, { error: "Peer not found" });
        return;
      }
      
      const consumerTransport = peer.transports[data.serverConsumerTransportId];
      if (!consumerTransport) {
        safeCallback(callback, { error: "Consumer transport not found" });
        return;
      }
      
      console.log(`${LOG_PREFIX} Creating consumer for producer ${data.remoteProducerId} for user ${socket.userId}`);
      
      const consumer = await consumerTransport.consume({
        producerId: data.remoteProducerId,
        rtpCapabilities: data.rtpCapabilities
      });
      
      peer.consumers.set(consumer.id, consumer);
      console.log(`${LOG_PREFIX} Consumer created: ${consumer.id} for user ${socket.userId}`);
      
      safeCallback(callback, {
        id: consumer.id,
        producerId: data.remoteProducerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        serverConsumerId: consumer.id
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating consumer:`, error);
      safeCallback(callback, { error: error.message });
    }
  });

  // consumer-resume: acknowledge resume
  socket.on("consumer-resume", async (data, callback) => {
    try {
      const room = rooms.get(socket.roomName);
      if (!room) {
        safeCallback(callback, { error: "Room not found" });
        return;
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        safeCallback(callback, { error: "Peer not found" });
        return;
      }
      
      const consumer = peer.consumers.get(data.serverConsumerId);
      if (!consumer) {
        safeCallback(callback, { error: "Consumer not found" });
        return;
      }
      
      await consumer.resume();
      safeCallback(callback);
    } catch (error) {
      safeCallback(callback, { error: error.message });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`${LOG_PREFIX} Socket ${socket.id} disconnected. Reason: ${reason}`);
    handleUserLeaving(socket);
  });
});

// ------------------------------
// Helper: Handle Peer Leaving
// ------------------------------
function handleUserLeaving(socket) {
  const roomName = socket.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (!room) return;
  socket.to(roomName).emit("userLeft", { userId: socket.userId });
  const peer = room.peers.get(socket.id);
  if (peer) {
    for (const key in peer.transports) {
      try {
        peer.transports[key].close();
      } catch (e) {
        console.error(`${LOG_PREFIX} Error closing transport ${key} for socket ${socket.id}:`, e);
      }
    }
    peer.producers.forEach((producer) => {
      try {
        producer.close();
      } catch (e) {
        console.error(`${LOG_PREFIX} Error closing producer ${producer.id} for socket ${socket.id}:`, e);
      }
      socket.to(roomName).emit("producerClosed", { remoteProducerId: producer.id, userId: socket.userId });
    });
    peer.consumers.forEach((consumer) => {
      try {
        consumer.close();
      } catch (e) {
        console.error(`${LOG_PREFIX} Error closing consumer ${consumer.id} for socket ${socket.id}:`, e);
      }
    });
  }
  room.peers.delete(socket.id);
  socket.leave(roomName);
  console.log(`${LOG_PREFIX} User ${socket.userId} left room ${roomName}`);
  
  // If this is a breakout room and it's now empty, notify the main room
  if (socket.isBreakoutRoom && socket.mainRoomId && room.peers.size === 0) {
    const mainRoom = rooms.get(socket.mainRoomId);
    if (mainRoom) {
      io.to(socket.mainRoomId).emit("breakoutRoomEmpty", {
        breakoutRoomId: roomName
      });
    }
  }
  
  if (room.peers.size === 0) {
    console.log(`${LOG_PREFIX} Room ${roomName} is empty. Cleaning up.`);
    closeAndCleanupRoom(roomName);
    
    // If this was a main room with breakout rooms, clean those up too
    const breakoutRoomIds = breakoutRooms.get(roomName) || [];
    if (breakoutRoomIds.length > 0) {
      console.log(`${LOG_PREFIX} Cleaning up ${breakoutRoomIds.length} breakout rooms for main room ${roomName}`);
      breakoutRoomIds.forEach(breakoutRoomId => {
        const breakoutRoom = rooms.get(breakoutRoomId);
        if (breakoutRoom) {
          // Notify any remaining users in breakout rooms that the main room is closed
          io.to(breakoutRoomId).emit("mainRoomClosed", {
            mainRoomId: roomName
          });
          closeAndCleanupRoom(breakoutRoomId);
        }
        breakoutToMainRoom.delete(breakoutRoomId);
      });
      breakoutRooms.delete(roomName);
    }
  }
}

async function closeAndCleanupRoom(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;
  try {
    room.router.close();
    console.log(`${LOG_PREFIX} Closed router for room ${roomName}`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error closing router for room ${roomName}:`, error);
  }
  releaseWorker(room.worker);
  rooms.delete(roomName);
  console.log(`${LOG_PREFIX} Room ${roomName} removed from active rooms`);
}

// ------------------------------
// Start Server
// ------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`${LOG_PREFIX} Server is running on port ${PORT}`);
  console.log(`${LOG_PREFIX} Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`${LOG_PREFIX} Workers count: ${workers.length}`);
  console.log(`${LOG_PREFIX} Announced IP: ${process.env.ANNOUNCED_IP || "default"}`);
  console.log(`${LOG_PREFIX} Available endpoints:`);
  console.log(`${LOG_PREFIX} - GET /health`);
  console.log(`${LOG_PREFIX} - GET /`);
  console.log(`${LOG_PREFIX} - WebSocket connection`);
});

io.on("error", (error) => {
  console.error(`${LOG_PREFIX} Socket.io server error:`, error);
});

io.engine.on("connection_error", (err) => {
  console.error(`${LOG_PREFIX} Socket.io connection error:`, err);
  if (err.code === 1) {
    console.error(`${LOG_PREFIX} Transport error:`, err.message);
  } else if (err.code === 2) {
    console.error(`${LOG_PREFIX} Protocol error:`, err.message);
  }
});

io.engine.on("upgradeError", (err) => {
  console.error(`${LOG_PREFIX} Socket.io upgrade error:`, err);
});

io.engine.on("transportError", (err) => {
  console.error(`${LOG_PREFIX} Socket.io transport error:`, err);
});

io.engine.on("wsError", (err) => {
  console.error(`${LOG_PREFIX} Socket.io websocket error:`, err);
});

io.engine.on("close", (err) => {
  console.error(`${LOG_PREFIX} Socket.io connection closed:`, err);
});

io.use((socket, next) => {
  const clientVersion = socket.handshake.headers["x-client-version"];
  const clientType = socket.handshake.headers["x-client-type"];
  console.log(`${LOG_PREFIX} Client connected with version: ${clientVersion}, type: ${clientType}`);
  next();
});

io.use((socket, next) => {
  const clientTime = socket.handshake.query.clientTime;
  if (clientTime) {
    const timeDiff = Date.now() - parseInt(clientTime);
    console.log(`${LOG_PREFIX} Client time difference: ${timeDiff}ms`);
  }
  next();
});

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

function cleanupAndExit() {
  console.log(`${LOG_PREFIX} Cleaning up rooms before exit...`);
  for (const roomName of rooms.keys()) {
    closeAndCleanupRoom(roomName);
  }
  server.close(() => {
    console.log(`${LOG_PREFIX} Server closed successfully`);
    process.exit(0);
  });
  setTimeout(() => {
    console.error(`${LOG_PREFIX} Forced exit due to cleanup timeout`);
    process.exit(1);
  }, 5000);
}

app.use((req, res, next) => {
  console.log(`${LOG_PREFIX} Setting CORS headers for request from ${req.ip}`);
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

function safeCallback(callback, data) {
  if (typeof callback === 'function') {
    try {
      callback(data);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error in callback:`, error);
    }
  }
}