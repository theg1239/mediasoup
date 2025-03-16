"use strict";

const fs = require("fs");
const https = require("https");
const express = require("express");
const cors = require("cors");
const socketIo = require("socket.io");
const mediasoup = require("mediasoup");
const os = require("os");
const path = require("path");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const LOG_PREFIX = "[MediasoupServer]";

// Add timestamp to logs
const log = {
  info: (message, ...args) => console.log(`${LOG_PREFIX} [${new Date().toISOString()}] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`${LOG_PREFIX} [${new Date().toISOString()}] ${message}`, ...args),
  error: (message, ...args) => console.error(`${LOG_PREFIX} [${new Date().toISOString()}] ${message}`, ...args),
  debug: (message, ...args) => console.debug(`${LOG_PREFIX} [${new Date().toISOString()}] ${message}`, ...args)
};

app.use(express.json());
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET || "haha",
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: true,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

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
      "https://acm.today",
      "https://enrollments-25.vercel.app",
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
let useAlternativeMeetingLinks = false;

app.post("/admin/toggle-kill-switch", (req, res) => {
  const { enabled, secret } = req.body || {};
  
  if (secret !== process.env.ADMIN_SECRET) {
    console.log(`${LOG_PREFIX} Unauthorized kill switch toggle attempt`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  useAlternativeMeetingLinks = enabled === true;
  console.log(`${LOG_PREFIX} Kill switch ${useAlternativeMeetingLinks ? 'ENABLED' : 'DISABLED'}`);
  
  io.emit('server-status-change', { 
    useAlternativeMeetingLinks,
    timestamp: Date.now()
  });
  
  res.status(200).json({ 
    status: "success", 
    useAlternativeMeetingLinks 
  });
});

app.get("/health", (req, res) => {
  log.info(`Health check requested from ${req.ip}`);
  res.status(200).json({ 
    status: "ok", 
    uptime: process.uptime(),
    useAlternativeMeetingLinks,
    timestamp: Date.now()
  });
});

app.use(express.static("public"));

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
});

app.get("/", (req, res) => {
  log.info(`Root endpoint requested from ${req.ip}`);
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
  cors: {
    origin: ["http://localhost:3000", "https://acm.today", "https://enrollments-25.vercel.app", process.env.FRONTEND_URL || "*"],
    methods: ["GET", "POST"],
    credentials: true
  },
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
log.info(`HTTPS and Socket.IO server initialized`);

// ------------------------------
// Helper: Get Listen IPs for mediasoup
// ------------------------------
function getListenIps() {
  console.log(`${LOG_PREFIX} Determining listen IPs for mediasoup...`);
  const interfaces = os.networkInterfaces();
  console.log(`${LOG_PREFIX} Available network interfaces:`, interfaces);
  
  const listenIps = [];
  const publicIp = process.env.ANNOUNCED_IP || null;
  
  // Always add 0.0.0.0 with the announced IP
  listenIps.push({ 
    ip: "0.0.0.0", 
    announcedIp: publicIp 
  });
  
  console.log(`${LOG_PREFIX} Using listen IP: 0.0.0.0 with announced IP: ${publicIp || 'none'}`);
  
  // If no public IP is set, try to find a reasonable default
  if (!publicIp) {
    console.warn(`${LOG_PREFIX} WARNING: No ANNOUNCED_IP set. Remote clients may have connectivity issues.`);
    
    // Try to find a non-internal IP to use as fallback
    let fallbackIp = null;
    
    try {
      // Look for a public-facing IP
      Object.keys(interfaces).forEach((interfaceName) => {
        const networkInterface = interfaces[interfaceName];
        if (networkInterface) {
          networkInterface.forEach((address) => {
            // Skip internal and IPv6 addresses
            if (!address.internal && address.family === 'IPv4') {
              fallbackIp = address.address;
              console.log(`${LOG_PREFIX} Found potential fallback IP: ${fallbackIp} on interface ${interfaceName}`);
            }
          });
        }
      });
      
      // If we found a fallback IP, add it as an option
      if (fallbackIp && fallbackIp !== '127.0.0.1') {
        listenIps.push({ 
          ip: fallbackIp, 
          announcedIp: null 
        });
        console.log(`${LOG_PREFIX} Added fallback listen IP: ${fallbackIp}`);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Error finding fallback IP:`, error);
    }
  }
  
  // Ensure we have at least one valid listen IP
  if (listenIps.length === 0) {
    console.error(`${LOG_PREFIX} No valid listen IPs found, using 127.0.0.1 as fallback`);
    listenIps.push({ 
      ip: "127.0.0.1", 
      announcedIp: null 
    });
  }
  
  console.log(`${LOG_PREFIX} Final listen IPs:`, JSON.stringify(listenIps));
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

// Helper function to safely execute callbacks
function safeCallback(callback, data = {}) {
  if (typeof callback === 'function') {
    try {
      callback(data);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error in callback execution:`, error);
    }
  } else {
    console.warn(`${LOG_PREFIX} Callback is not a function`);
  }
}

// Helper function to check if a user is an admin
function isAdmin(userEmail, socket) {
  // If socket is provided and has isAdmin flag set, use that
  if (socket && socket.isAdmin === true) {
    return true;
  }
  
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
  
  // Check router state
  if (!router || router.closed) {
    console.error(`${LOG_PREFIX} Router is invalid or closed: ${router?.id}`);
    throw new Error("Router is invalid or closed");
  }
  
  const { listenIps, initialAvailableOutgoingBitrate, maxIncomingBitrate } = mediasoupOptions.webRtcTransport;
  
  // Validate listenIps
  if (!listenIps || !Array.isArray(listenIps) || listenIps.length === 0) {
    console.error(`${LOG_PREFIX} Invalid listenIps configuration:`, listenIps);
    throw new Error("Invalid listenIps configuration");
  }
  
  console.log(`${LOG_PREFIX} Using listenIps:`, JSON.stringify(listenIps));
  
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
    
    console.log(`${LOG_PREFIX} Creating transport with options:`, JSON.stringify({
      enableUdp: transportOptions.enableUdp,
      enableTcp: transportOptions.enableTcp,
      preferUdp: transportOptions.preferUdp,
      initialAvailableOutgoingBitrate: transportOptions.initialAvailableOutgoingBitrate,
      iceConsentTimeout: transportOptions.iceConsentTimeout
    }));
    
    router.createWebRtcTransport(transportOptions)
      .then(async (transport) => {
        clearTimeout(timeout);
        log.info(`WebRTC transport created: ${transport.id}`);
        
        if (maxIncomingBitrate) {
          try {
            await transport.setMaxIncomingBitrate(maxIncomingBitrate);
            log.info(`Set max incoming bitrate to ${maxIncomingBitrate} for ${transport.id}`);
          } catch (bitrateError) {
            log.warn(`Error setting max incoming bitrate: ${bitrateError.message}`);
            // Continue despite bitrate setting error
          }
        }
        
        transport.on("routerclose", () =>
          log.info(`Transport ${transport.id} closed (router closed)`)
        );
        
        transport.on("icestatechange", (state) => {
          log.info(`Transport ${transport.id} ICE state changed to: ${state}`);
          if (state === "failed") {
            transport.restartIce()
              .then(() => log.info(`ICE restarted for transport ${transport.id}`))
              .catch((error) => log.error(`ICE restart error for transport ${transport.id}:`, error));
          }
        });
        
        transport.on("dtlsstatechange", (state) => {
          log.info(`Transport ${transport.id} DTLS state: ${state}`);
        });
        
        transport.on("sctpstatechange", (state) => {
          log.info(`Transport ${transport.id} SCTP state: ${state}`);
        });
        
        const params = {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters
        };
        
        log.info(`Transport params ready: ${transport.id}`);
        
        resolve({
          transport,
          params
        });
      })
      .catch((error) => {
        clearTimeout(timeout);
        log.error(`Error creating WebRTC transport:`, error);
        log.error(`Transport options used:`, JSON.stringify({
          listenIps: transportOptions.listenIps,
          enableUdp: transportOptions.enableUdp,
          enableTcp: transportOptions.enableTcp
        }));
        reject(error);
      });
  });
}

// ------------------------------
// Dashboard Authentication & API Endpoints
// ------------------------------

const adminTokens = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  const email = req.headers['x-admin-email'];
  
  if (!token || !email || !adminTokens.has(email) || adminTokens.get(email) !== token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  next();
}

// Dashboard API routes
app.post("/api/auth", (req, res) => {
  const { email, secret } = req.body || {};
  
  if (!email || !secret) {
    return res.status(400).json({ error: "Email and secret are required" });
  }
  
  const facetimeEmails = (process.env.FACETIME_EMAILS || "").split(",").map(e => e.trim().toLowerCase());
  
  if (!facetimeEmails.includes(email.toLowerCase()) || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  
  const token = generateToken();
  adminTokens.set(email, token);
  
  res.status(200).json({ 
    status: "success",
    token
  });
});

app.get("/api/server-stats", requireAuth, (req, res) => {
  const stats = getServerStats();
  res.status(200).json(stats);
});

app.get("/api/rooms", requireAuth, (req, res) => {
  const roomsData = getRoomsData();
  res.status(200).json(roomsData);
});

app.get("/api/breakout-rooms", requireAuth, (req, res) => {
  const breakoutRoomsData = getBreakoutRoomsData();
  res.status(200).json(breakoutRoomsData);
});

app.post("/api/rooms/:roomId/close", requireAuth, (req, res) => {
  const { roomId } = req.params;
  
  if (!rooms.has(roomId) && !breakoutRooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }
  
  closeAndCleanupRoom(roomId)
    .then(() => {
      res.status(200).json({ status: "success" });
    })
    .catch(err => {
      log.error(`Error closing room:`, err);
      res.status(500).json({ error: "Failed to close room" });
    });
});

app.post("/api/rooms/:roomId/users/:userId/kick", requireAuth, (req, res) => {
  const { roomId, userId } = req.params;
  
  if (!rooms.has(roomId) && !breakoutRooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }
  
  const room = rooms.get(roomId);
  const userSocket = [...io.sockets.sockets.values()].find(s => s.id === userId || s.userId === userId);
  
  if (!userSocket) {
    return res.status(404).json({ error: "User not found" });
  }
  
  userSocket.emit('kicked');
  userSocket.disconnect(true);
  
  res.status(200).json({ status: "success" });
});

function getServerStats() {
  const cpuUsage = process.cpuUsage();
  const memoryUsage = process.memoryUsage();
  
  const networkInterfaces = os.networkInterfaces();
  
  return {
    uptime: process.uptime(),
    cpuUsage: (cpuUsage.user + cpuUsage.system) / 1000000,
    memoryUsage: memoryUsage.rss,
    heapUsage: memoryUsage.heapUsed,
    workersCount: workers.length,
    roomsCount: rooms.size,
    breakoutRoomsCount: breakoutRooms.size,
    usersCount: io.sockets.sockets.size,
    hostname: os.hostname(),
    platform: os.platform(),
    cpuCores: os.cpus().length,
    totalMemory: os.totalmem(),
    networkInterfaces,
    useAlternativeMeetingLinks,
    workers: workers.map(worker => ({
      pid: worker.pid,
      load: workerLoadCount.get(worker) || 0
    }))
  };
}

function getRoomsData() {
  const roomsData = [];
  
  for (const [roomId, room] of rooms.entries()) {
    if (breakoutToMainRoom.has(roomId)) continue;
    
    const users = [];
    
    for (const [socketId, socket] of io.sockets.sockets.entries()) {
      if (socket.roomId === roomId) {
        users.push({
          id: socketId,
          displayName: socket.displayName || 'Anonymous',
          role: socket.role || 'Participant'
        });
      }
    }
    
    roomsData.push({
      roomId,
      createdAt: room.createdAt || Date.now(),
      workerId: room.workerId || 0,
      users
    });
  }
  
  return roomsData;
}

function getBreakoutRoomsData() {
  const breakoutRoomsData = [];
  
  for (const [roomId, room] of rooms.entries()) {
    if (!breakoutToMainRoom.has(roomId)) continue;
    
    const mainRoomId = breakoutToMainRoom.get(roomId);
    const users = [];
    
    for (const [socketId, socket] of io.sockets.sockets.entries()) {
      if (socket.roomId === roomId) {
        users.push({
          id: socketId,
          displayName: socket.displayName || 'Anonymous',
          role: socket.role || 'Participant'
        });
      }
    }
    
    breakoutRoomsData.push({
      roomId,
      mainRoomId,
      createdAt: room.createdAt || Date.now(),
      workerId: room.workerId || 0,
      users
    });
  }
  
  return breakoutRoomsData;
}

// ------------------------------
// Socket & Room Management
// ------------------------------
io.on("connection", async (socket) => {
  log.info(`New socket connection: ${socket.id} from ${socket.handshake.address}`);
  
  // Track connection time for debugging
  socket.connectionTime = Date.now();
  
  // Handle dashboard authentication
  const authData = socket.handshake.auth || {};
  
  // Check if this is a dashboard admin connection
  if (authData.email && (authData.secret || authData.token)) {
    handleDashboardConnection(socket, authData);
    return;
  }

  socket.data = {};

  // Handle user joining a room
  socket.on("joinRoom", async (data, callback) => {
    try {
      const { roomName, userId, userName, userEmail, isBreakoutRoom = false, mainRoomId = null } = data;
      
      log.info(`User ${userName} (${userId}) joining room ${roomName}`, {
        socketId: socket.id,
        isBreakoutRoom,
        mainRoomId
      });
      
      // Get or create the room
      const room = await getOrCreateRoom(roomName);
      
      // Set admin status on the socket
      socket.isAdmin = isAdmin(userEmail, socket);
      socket.userEmail = userEmail;
      
      // Check if user is already in the room
      if (room.peers.has(socket.id)) {
        log.info(`User ${userName} (${userId}) already in room ${roomName}`);
        // Just update the callback with current state
        safeCallback(callback, {
          rtpCapabilities: room.router.rtpCapabilities,
          isAdmin: socket.isAdmin,
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
      safeCallback(callback, {
        rtpCapabilities: room.router.rtpCapabilities,
        existingProducers,
        isAdmin: socket.isAdmin,
        isBreakoutRoom,
        mainRoomId,
        chatHistory: room.chatHistory || []
      });
      
      log.info(`User ${userName} (${userId}) joined room ${roomName}`);
    } catch (error) {
      log.error(`Error joining room:`, error);
      safeCallback(callback, { error: error.message || "Internal server error" });
    }
  });

  // Handle user leaving a room
  socket.on("leaveRoom", async (data) => {
    try {
      const { roomName, userId, isMovingToBreakoutRoom, isReturningToMainRoom } = data;
      log.info(`User ${socket.userName} (${userId}) leaving room ${roomName}`);
      
      // Special handling for breakout room transitions
      const isTransitioning = isMovingToBreakoutRoom || isReturningToMainRoom;
      
      // Get the room
      const room = rooms.get(roomName);
      if (!room) {
        log.info(`Room ${roomName} not found for user leaving`);
        return;
      }
      
      // Get the peer
      const peer = room.peers.get(socket.id);
      if (!peer) {
        log.info(`Peer not found in room ${roomName}`);
        return;
      }

      // Close all transports
      for (const transport of peer.transports.values()) {
        try {
          transport.close();
        } catch (error) {
          log.error(`Error closing transport:`, error);
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
      
      log.info(`User ${socket.userName} (${userId}) left room ${roomName}`);
    } catch (error) {
      log.error(`Error leaving room:`, error);
    }
  });

  // Handle screen sharing events
  socket.on("screenShareStarted", (data) => {
    try {
      const { userId, userName, hasCamera } = data;
      const roomName = socket.roomName;
      
      if (!roomName) {
        log.error(`No room found for screen share start`);
        return;
      }
      
      log.info(`User ${userName} (${userId}) started screen sharing in room ${roomName}`);
      
      // Broadcast to all users in the room except the sender
      socket.to(roomName).emit("screenShareStarted", { userId, userName, hasCamera });
    } catch (error) {
      log.error(`Error handling screen share start:`, error);
    }
  });

  socket.on("screenShareStopped", (data) => {
    try {
      const { userId } = data || { userId: socket.userId };
      const roomName = socket.roomName;
      
      if (!roomName) {
        log.error(`No room found for screen share stop`);
        return;
      }
      
      log.info(`User ${socket.userName} (${userId}) stopped screen sharing in room ${roomName}`);
      
      // Broadcast to all users in the room except the sender
      socket.to(roomName).emit("screenShareStopped", { userId });
    } catch (error) {
      log.error(`Error handling screen share stop:`, error);
    }
  });

  // Handle chat messages
  socket.on("chatMessage", (data) => {
    try {
      const { roomId, userId, userName, message, timestamp } = data;
      
      if (!roomId) {
        log.error(`No room ID provided for chat message`);
        return;
      }
      
      log.info(`Chat message from ${userName} (${userId}) in room ${roomId}: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
      
      // Add the message to the room's chat history if needed
      const room = rooms.get(roomId);
      if (!room) {
        log.error(`Room ${roomId} not found for chat message`);
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
      log.error(`Error handling chat message:`, error);
    }
  });

  // Handle room users request
  socket.on("getRoomUsers", (data) => {
    try {
      const { roomId } = data;
      
      if (!roomId) {
        log.error(`No room ID provided for getRoomUsers`);
        return;
      }
      
      log.info(`Getting users for room ${roomId}`);
      
      const room = rooms.get(roomId);
      if (!room) {
        log.error(`Room ${roomId} not found for getRoomUsers`);
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
      
      log.info(`Sent ${users.length} users for room ${roomId}`);
    } catch (error) {
      log.error(`Error handling getRoomUsers:`, error);
    }
  });

  // Handle breakout room creation
  socket.on("createBreakoutRooms", async (data, callback) => {
    try {
      const { count, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can create breakout rooms" });
        return;
      }
      
      log.info(`Creating ${count} breakout rooms for main room ${mainRoomId}`);
      
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
      log.error(`Error creating breakout rooms:`, error);
      callback({ error: error.message });
    }
  });

  // Handle assigning users to breakout rooms
  socket.on("assignToBreakoutRoom", async (data, callback) => {
    try {
      const { userId, breakoutRoomId, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can assign users to breakout rooms" });
        return;
      }
      
      log.info(`Assigning user ${userId} to breakout room ${breakoutRoomId}`);
      
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
      log.error(`Error assigning user to breakout room:`, error);
      callback({ error: error.message });
    }
  });

  // Handle returning all users to main room
  socket.on("returnAllToMainRoom", async (data, callback) => {
    try {
      const { mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can return users to main room" });
        return;
      }
      
      log.info(`Returning all users to main room ${mainRoomId}`);
      
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
      log.error(`Error returning users to main room:`, error);
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

  // Handle createWebRtcTransport request
  socket.on("createWebRtcTransport", async (data, callback) => {
    try {
      log.info(`Creating WebRTC transport for user ${socket.userId}, consumer: ${data.consumer}, socketId: ${socket.id}`);
      log.info(`Socket state: connected=${socket.connected}, roomName=${socket.roomName}`);
      
      // Validate room and peer
      const room = rooms.get(socket.roomName);
      if (!room) {
        log.error(`Room not found for transport creation: ${socket.roomName}`);
        log.error(`Available rooms: ${Array.from(rooms.keys()).join(', ')}`);
        safeCallback(callback, { error: "Room not found" });
        return;
      }
      
      const peer = room.peers.get(socket.id);
      if (!peer) {
        log.error(`Peer not found for transport creation: ${socket.id}`);
        log.error(`Available peers in room: ${Array.from(room.peers.keys()).join(', ')}`);
        safeCallback(callback, { error: "Peer not found" });
        return;
      }
      
      // Create the WebRTC transport
      log.info(`Creating WebRTC transport with router ${room.router.id}`);
      
      try {
        const { transport, params } = await createWebRtcTransport(room.router);
        
        // Store the transport
        peer.transports[transport.id] = transport;
        
        // Handle transport closure
        transport.on("close", () => {
          log.info(`Transport ${transport.id} closed`);
          delete peer.transports[transport.id];
        });
        
        // Notify client about transport creation
        log.info(`WebRTC transport created successfully: ${transport.id}`);
        socket.emit("webrtc-transport-created", {
          transportId: transport.id,
          type: data.consumer ? "consumer" : "producer"
        });
        
        // Return transport parameters to client
        log.info(`Sending transport params back to client: ${JSON.stringify(params.id)}`);
        safeCallback(callback, { params });
      } catch (transportError) {
        log.error(`Error in createWebRtcTransport function:`, transportError);
        log.error(`Router state: id=${room.router.id}, closed=${room.router.closed}`);
        safeCallback(callback, { error: `Transport creation error: ${transportError.message}` });
      }
    } catch (error) {
      log.error(`Error creating WebRTC transport:`, error);
      safeCallback(callback, { error: error.message });
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
        log.error(`Room not found for user ${socket.userId}`);
        safeCallback(callback, { error: "Room not found" });
        return;
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        log.error(`Peer not found for user ${socket.userId}`);
        safeCallback(callback, { error: "Peer not found" });
        return;
      }
      
      const transport = peer.transports[data.transportId];
      if (!transport) {
        log.error(`Transport not found for user ${socket.userId}`);
        safeCallback(callback, { error: "Transport not found" });
        return;
      }
      
      log.info(`Creating producer for user ${socket.userId} with kind ${data.kind}`);
      
      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: data.appData
      });
      
      peer.producers.set(producer.id, producer);
      log.info(`Producer created: ${producer.id} for user ${socket.userId}`);
      
      // Handle producer closure
      producer.on("transportclose", () => {
        log.info(`Producer ${producer.id} closed due to transport closure`);
        producer.close();
        peer.producers.delete(producer.id);
      });
      
      // Notify other users about the new producer
      socket.to(socket.roomName).emit("newProducer", {
        producerId: producer.id,
        userId: socket.userId,
        userName: socket.userName,
        kind: data.kind
      });
      
      safeCallback(callback, { id: producer.id });
    } catch (error) {
      log.error(`Error creating producer:`, error);
      safeCallback(callback, { error: error.message });
    }
  });

  // Handle deviceReady event - client is ready to receive consumers
  socket.on("deviceReady", async (data, callback) => {
    try {
      log.info(`Device ready for user ${socket.userId}`);
      
      const room = rooms.get(socket.roomName);
      if (!room) {
        log.error(`Room not found for deviceReady: ${socket.roomName}`);
        safeCallback(callback, { error: "Room not found" });
        return;
      }
      
      const peer = room.peers.get(socket.id);
      if (!peer) {
        log.error(`Peer not found for deviceReady: ${socket.id}`);
        safeCallback(callback, { error: "Peer not found" });
        return;
      }
      
      // Mark the peer's device as loaded
      peer.deviceLoaded = true;
      log.info(`Device marked as loaded for user ${socket.userId}`);
      
      // Notify the client that we've received their deviceReady event
      safeCallback(callback, { success: true });
    } catch (error) {
      log.error(`Error handling deviceReady:`, error);
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
      
      log.info(`Connecting consumer transport ${data.serverConsumerTransportId} for user ${socket.userId}`);
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      safeCallback(callback);
    } catch (error) {
      log.error(`Error connecting consumer transport:`, error);
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
      
      log.info(`Creating consumer for producer ${data.remoteProducerId} for user ${socket.userId}`);
      
      const consumer = await consumerTransport.consume({
        producerId: data.remoteProducerId,
        rtpCapabilities: data.rtpCapabilities
      });
      
      peer.consumers.set(consumer.id, consumer);
      log.info(`Consumer created: ${consumer.id} for user ${socket.userId}`);
      
      safeCallback(callback, {
        id: consumer.id,
        producerId: data.remoteProducerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        serverConsumerId: consumer.id
      });
    } catch (error) {
      log.error(`Error creating consumer:`, error);
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

  // getBreakoutRoomParticipants
  socket.on("getBreakoutRoomParticipants", async (data, callback) => {
    try {
      const { breakoutRoomId, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can get breakout room participants" });
        return;
      }
      
      log.info(`Getting participants for breakout room ${breakoutRoomId}`);
      
      // Get the breakout room
      const breakoutRoom = rooms.get(breakoutRoomId);
      if (!breakoutRoom) {
        callback({ error: "Breakout room not found" });
        return;
      }
      
      // Collect participant information
      const participants = [];
      for (const [peerId, peer] of breakoutRoom.peers.entries()) {
        participants.push({
          id: peer.userId,
          name: peer.userName,
          initials: peer.userName.substring(0, 2)
        });
      }
      
      callback({ participants });
      
      log.info(`Sent ${participants.length} participants for breakout room ${breakoutRoomId}`);
    } catch (error) {
      log.error(`Error handling getBreakoutRoomParticipants:`, error);
      callback({ error: "Internal server error" });
    }
  });

  // closeBreakoutRoom
  socket.on("closeBreakoutRoom", async (data, callback) => {
    try {
      const { breakoutRoomId, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can close breakout rooms" });
        return;
      }
      
      log.info(`Closing breakout room ${breakoutRoomId}`);
      
      // Get the breakout room
      const breakoutRoom = rooms.get(breakoutRoomId);
      if (!breakoutRoom) {
        callback({ error: "Breakout room not found" });
        return;
      }
      
      // Get the main room
      const mainRoom = rooms.get(mainRoomId);
      if (!mainRoom) {
        callback({ error: "Main room not found" });
        return;
      }
      
      // Notify all users in the breakout room to return to the main room
      io.to(breakoutRoomId).emit("returnToMainRoom", { mainRoomId });
      
      // Update breakout rooms tracking
      const breakoutRoomsForMain = breakoutRooms.get(mainRoomId) || [];
      const updatedBreakoutRooms = breakoutRoomsForMain.filter(id => id !== breakoutRoomId);
      breakoutRooms.set(mainRoomId, updatedBreakoutRooms);
      
      // Remove the mapping from breakout to main
      breakoutToMainRoom.delete(breakoutRoomId);
      
      callback({ success: true });
      
      log.info(`Closed breakout room ${breakoutRoomId}`);
    } catch (error) {
      log.error(`Error handling closeBreakoutRoom:`, error);
      callback({ error: "Internal server error" });
    }
  });

  // messageBreakoutRoom
  socket.on("messageBreakoutRoom", async (data, callback) => {
    try {
      const { breakoutRoomId, mainRoomId, message, fromAdmin } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can message breakout rooms" });
        return;
      }
      
      log.info(`Sending message to breakout room ${breakoutRoomId}: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
      
      // Get the breakout room
      const breakoutRoom = rooms.get(breakoutRoomId);
      if (!breakoutRoom) {
        callback({ error: "Breakout room not found" });
        return;
      }
      
      // Send the admin message to all users in the breakout room
      io.to(breakoutRoomId).emit("adminBroadcast", { message, fromAdmin });
      
      callback({ success: true });
      
      log.info(`Sent message to breakout room ${breakoutRoomId}`);
    } catch (error) {
      log.error(`Error handling messageBreakoutRoom:`, error);
      callback({ error: "Internal server error" });
    }
  });

  // returnParticipantToMainRoom
  socket.on("returnParticipantToMainRoom", async (data, callback) => {
    try {
      const { participantId, breakoutRoomId, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can return participants to main room" });
        return;
      }
      
      log.info(`Returning participant ${participantId} from breakout room ${breakoutRoomId} to main room ${mainRoomId}`);
      
      // Get the breakout room
      const breakoutRoom = rooms.get(breakoutRoomId);
      if (!breakoutRoom) {
        callback({ error: "Breakout room not found" });
        return;
      }
      
      // Get the main room
      const mainRoom = rooms.get(mainRoomId);
      if (!mainRoom) {
        callback({ error: "Main room not found" });
        return;
      }
      
      // Find the participant's socket
      let participantSocket = null;
      for (const [peerId, peer] of breakoutRoom.peers.entries()) {
        if (peer.userId === participantId) {
          participantSocket = io.sockets.sockets.get(peerId);
          break;
        }
      }
      
      if (!participantSocket) {
        callback({ error: "Participant not found in breakout room" });
        return;
      }
      
      // Notify the participant to return to the main room
      participantSocket.emit("returnToMainRoom", { mainRoomId });
      
      callback({ success: true });
      
      log.info(`Returned participant ${participantId} to main room ${mainRoomId}`);
    } catch (error) {
      log.error(`Error handling returnParticipantToMainRoom:`, error);
      callback({ error: "Internal server error" });
    }
  });

  // moveParticipantToBreakoutRoom
  socket.on("moveParticipantToBreakoutRoom", async (data, callback) => {
    try {
      const { participantId, fromBreakoutRoomId, toBreakoutRoomId, mainRoomId } = data;
      
      // Check if user is admin
      if (!isAdmin(socket.userEmail, socket)) {
        callback({ error: "Only admins can move participants between breakout rooms" });
        return;
      }
      
      log.info(`Moving participant ${participantId} from breakout room ${fromBreakoutRoomId} to ${toBreakoutRoomId}`);
      
      // Get the source breakout room
      const fromRoom = rooms.get(fromBreakoutRoomId);
      if (!fromRoom) {
        callback({ error: "Source breakout room not found" });
        return;
      }
      
      // Get the target breakout room
      const toRoom = rooms.get(toBreakoutRoomId);
      if (!toRoom) {
        callback({ error: "Target breakout room not found" });
        return;
      }
      
      // Find the participant's socket
      let participantSocket = null;
      let participantName = "";
      for (const [peerId, peer] of fromRoom.peers.entries()) {
        if (peer.userId === participantId) {
          participantSocket = io.sockets.sockets.get(peerId);
          participantName = peer.userName;
          break;
        }
      }
      
      if (!participantSocket) {
        callback({ error: "Participant not found in source breakout room" });
        return;
      }
      
      // Notify the participant to move to the new breakout room
      participantSocket.emit("moveToBreakoutRoom", { 
        breakoutRoomId: toBreakoutRoomId, 
        mainRoomId 
      });
      
      callback({ success: true });
      
      log.info(`Moved participant ${participantId} from breakout room ${fromBreakoutRoomId} to ${toBreakoutRoomId}`);
    } catch (error) {
      log.error(`Error handling moveParticipantToBreakoutRoom:`, error);
      callback({ error: "Internal server error" });
    }
  });

  socket.on("disconnect", (reason) => {
    const connectionDuration = Date.now() - (socket.connectionTime || Date.now());
    log.info(`Socket ${socket.id} disconnected after ${connectionDuration}ms`, {
      userName: socket.userName || 'unknown',
      roomName: socket.roomName || 'unknown',
      userId: socket.userId || 'unknown'
    });
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
        log.error(`Error closing transport ${key} for socket ${socket.id}:`, e);
      }
    }
    peer.producers.forEach((producer) => {
      try {
        producer.close();
      } catch (e) {
        log.error(`Error closing producer ${producer.id} for socket ${socket.id}:`, e);
      }
      socket.to(roomName).emit("producerClosed", { remoteProducerId: producer.id, userId: socket.userId });
    });
    peer.consumers.forEach((consumer) => {
      try {
        consumer.close();
      } catch (e) {
        log.error(`Error closing consumer ${consumer.id} for socket ${socket.id}:`, e);
      }
    });
  }
  room.peers.delete(socket.id);
  socket.leave(roomName);
  log.info(`User ${socket.userId} left room ${roomName}`);
  
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
    log.info(`Room ${roomName} is empty. Cleaning up.`);
    closeAndCleanupRoom(roomName);
    
    // If this was a main room with breakout rooms, clean those up too
    const breakoutRoomIds = breakoutRooms.get(roomName) || [];
    if (breakoutRoomIds.length > 0) {
      log.info(`Cleaning up ${breakoutRoomIds.length} breakout rooms for main room ${roomName}`);
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
    log.info(`Closed router for room ${roomName}`);
  } catch (error) {
    log.error(`Error closing router for room ${roomName}:`, error);
  }
  releaseWorker(room.worker);
  rooms.delete(roomName);
  log.info(`Room ${roomName} removed from active rooms`);
}

// ------------------------------
// Start Server
// ------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log.info(`Server is running on port ${PORT}`);
  log.info(`Environment: ${process.env.NODE_ENV || "development"}`);
  log.info(`Workers count: ${workers.length}`);
  log.info(`Announced IP: ${process.env.ANNOUNCED_IP || "default"}`);
  log.info(`Available endpoints:`);
  log.info(` - GET /health`);
  log.info(` - GET /`);
  log.info(` - WebSocket connection`);
});

io.on("error", (error) => {
  log.error(`Socket.io server error:`, error);
});

io.engine.on("connection_error", (err) => {
  log.error(`Socket.io connection error:`, err);
  if (err.code === 1) {
    log.error(`Transport error:`, err.message);
  } else if (err.code === 2) {
    log.error(`Protocol error:`, err.message);
  }
});

io.engine.on("upgradeError", (err) => {
  log.error(`Socket.io upgrade error:`, err);
});

io.engine.on("transportError", (err) => {
  log.error(`Socket.io transport error:`, err);
});

io.engine.on("wsError", (err) => {
  log.error(`Socket.io websocket error:`, err);
});

io.engine.on("close", (err) => {
  log.error(`Socket.io connection closed:`, err);
});

io.use((socket, next) => {
  const clientVersion = socket.handshake.headers["x-client-version"];
  const clientType = socket.handshake.headers["x-client-type"];
  log.info(`Client connected with version: ${clientVersion}, type: ${clientType}`);
  next();
});

io.use((socket, next) => {
  const clientTime = socket.handshake.query.clientTime;
  if (clientTime) {
    const timeDiff = Date.now() - parseInt(clientTime);
    log.info(`Client time difference: ${timeDiff}ms`);
  }
  next();
});

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

function cleanupAndExit() {
  log.info(`Cleaning up rooms before exit...`);
  for (const roomName of rooms.keys()) {
    closeAndCleanupRoom(roomName);
  }
  server.close(() => {
    log.info(`Server closed successfully`);
    process.exit(0);
  });
  setTimeout(() => {
    log.error(`Forced exit due to cleanup timeout`);
    process.exit(1);
  }, 5000);
}

app.use((req, res, next) => {
  log.info(`Setting CORS headers for request from ${req.ip}`);
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

function handleDashboardConnection(socket, authData) {
  const { email, secret, token } = authData;
  
  if (token) {
    if (!adminTokens.has(email) || adminTokens.get(email) !== token) {
      socket.emit('auth_error', { message: 'Invalid token' });
      socket.disconnect(true);
      return;
    }
  } else {
    const facetimeEmails = (process.env.FACETIME_EMAILS || "").split(",").map(e => e.trim().toLowerCase());
    
    if (!facetimeEmails.includes(email.toLowerCase()) || secret !== process.env.ADMIN_SECRET) {
      socket.emit('auth_error', { message: 'Invalid credentials' });
      socket.disconnect(true);
      return;
    }
    
    const newToken = generateToken();
    adminTokens.set(email, newToken);
    socket.emit('auth_success', { token: newToken });
  }
  
  log.info(`Admin authenticated: ${email}`);
  
  socket.isAdmin = true;
  socket.adminEmail = email;
  
  setupDashboardSocketHandlers(socket);
}

function setupDashboardSocketHandlers(socket) {
  socket.on('get_server_stats', () => {
    const stats = getServerStats();
    socket.emit('server_stats', stats);
  });
  
  socket.on('get_rooms', () => {
    const roomsData = getRoomsData();
    socket.emit('rooms_data', roomsData);
  });
  
  socket.on('get_breakout_rooms', () => {
    const breakoutRoomsData = getBreakoutRoomsData();
    socket.emit('breakout_rooms_data', breakoutRoomsData);
  });
  
  socket.on('toggle_killswitch', (data) => {
    const { enabled } = data;
    useAlternativeMeetingLinks = enabled === true;
    
    log.info(`Killswitch ${useAlternativeMeetingLinks ? 'ENABLED' : 'DISABLED'} by admin: ${socket.adminEmail}`);
    
    io.emit('server-status-change', { 
      useAlternativeMeetingLinks,
      timestamp: Date.now()
    });
  });
  
  socket.on('close_room', async (data) => {
    const { roomId } = data;
    
    if (!rooms.has(roomId)) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    try {
      await closeAndCleanupRoom(roomId);
      
      socket.emit('room_closed', { roomId });
      socket.broadcast.emit('room_closed', { roomId });
      
      log.info(`Room ${roomId} closed by admin: ${socket.adminEmail}`);
    } catch (err) {
      log.error(`Error closing room:`, err);
      socket.emit('error', { message: 'Failed to close room' });
    }
  });
  
  socket.on('kick_user', (data) => {
    const { roomId, userId } = data;
    
    const userSocket = [...io.sockets.sockets.values()].find(s => s.id === userId || s.userId === userId);
    
    if (!userSocket) {
      socket.emit('error', { message: 'User not found' });
      return;
    }
    
    userSocket.emit('kicked');
    userSocket.disconnect(true);
    
    log.info(`User ${userId} kicked from room ${roomId} by admin: ${socket.adminEmail}`);
    
    socket.emit('user_kicked', { roomId, userId });
  });
  
  socket.on('disconnect', () => {
    log.info(`Admin disconnected: ${socket.adminEmail}`);
  });
}