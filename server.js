"use strict";

// ------------------------------
// Required Modules & Environment Setup
// ------------------------------
const express = require("express");
const https = require("https");
const fs = require("fs");
const cors = require("cors");
const socketIo = require("socket.io");
const mediasoup = require("mediasoup");
const os = require("os");
const path = require("path");
require("dotenv").config();

const app = express();

// Global log prefix for easier filtering
const LOG_PREFIX = "[MediasoupServer]";

// ------------------------------
// Load SSL Certificates
// ------------------------------
// Update the file paths to match where your certs are located.
// For example, if you generated them using the instructions and stored them in ./certs folder:
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, "mediasoup-certs", "key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "mediasoup-certs", "cert.pem"))
};

// ------------------------------
// CORS Options (adapt as needed)
// ------------------------------
const corsOptions = {
  origin: (origin, callback) => {
    console.log(`${LOG_PREFIX} CORS check for origin: ${origin}`);
    const allowedOrigins = [
      "http://localhost:3000",
      process.env.FRONTEND_URL || "*",
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
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// ------------------------------
// Health and Static File Endpoints
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
// Create HTTPS Server and Socket.IO Instance
// ------------------------------
const server = https.createServer(sslOptions, app);
const io = socketIo(server, {
  cors: corsOptions,
  pingTimeout: 60000, // Longer ping timeout
  pingInterval: 25000, // More frequent pings
  transports: ["websocket", "polling"],
});

console.log(`${LOG_PREFIX} HTTPS and Socket.IO server initialized`);

// ------------------------------
// Helper: Determine which IPs mediasoup should listen on
// ------------------------------
function getListenIps() {
  console.log(`${LOG_PREFIX} Determining listen IPs for mediasoup...`);
  const interfaces = os.networkInterfaces();
  console.log(`${LOG_PREFIX} Available network interfaces:`, interfaces);
  const listenIps = [];
  const publicIp = process.env.ANNOUNCED_IP || null;

  listenIps.push({
    ip: "0.0.0.0",
    announcedIp: publicIp,
  });

  console.log(`${LOG_PREFIX} Using listen IP: 0.0.0.0 with announced IP: ${publicIp}`);
  if (!publicIp) {
    console.warn(`${LOG_PREFIX} WARNING: No ANNOUNCED_IP environment variable set. Remote clients may have connectivity issues.`);
  }
  return listenIps;
}

// ------------------------------
// Mediasoup Options
// ------------------------------
const mediasoupOptions = {
  worker: {
    rtcMinPort: process.env.RTC_MIN_PORT || 40000,
    rtcMaxPort: process.env.RTC_MAX_PORT || 49999,
    logLevel: process.env.LOG_LEVEL || "warn",
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp", "verbose"],
  },
  router: {
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
          "x-google-min-bitrate": 600,
          "x-google-max-bitrate": 3000,
        },
      },
      {
        kind: "video",
        mimeType: "video/VP9",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
          "profile-id": 2,
          "x-google-min-bitrate": 600,
          "x-google-max-bitrate": 3000,
        },
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
          "x-google-max-bitrate": 3000,
        },
      },
    ],
  },
  webRtcTransport: {
    listenIps: getListenIps(),
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
    minimumAvailableOutgoingBitrate: 600000,
    maxSctpMessageSize: 262144,
    maxIncomingBitrate: 1500000,
  },
};

console.log(`${LOG_PREFIX} Mediasoup options configured:`, mediasoupOptions);

// ------------------------------
// Worker and Room Management
// ------------------------------
const roomsInCreation = new Map();
let workers = [];
const workerLoadCount = new Map();

async function createWorkers() {
  console.log(`${LOG_PREFIX} Starting creation of mediasoup workers...`);
  const numWorkers = process.env.NUM_WORKERS ? parseInt(process.env.NUM_WORKERS, 10) : 1;
  const coreCount = os.cpus().length;
  const count = Math.min(numWorkers, coreCount);
  console.log(`${LOG_PREFIX} Attempting to create ${count} workers (CPU cores: ${coreCount}, Requested: ${numWorkers})`);
  const workerPromises = [];
  for (let i = 0; i < count; i++) {
    console.log(`${LOG_PREFIX} Creating worker ${i}`);
    workerPromises.push(
      mediasoup
        .createWorker(mediasoupOptions.worker)
        .then((worker) => {
          console.log(`${LOG_PREFIX} Mediasoup Worker ${i} created with PID: ${worker.pid}`);
          worker.on("died", (error) => {
            console.error(`${LOG_PREFIX} Mediasoup Worker ${i} died with error: ${error.message}`);
            setTimeout(async () => {
              try {
                console.log(`${LOG_PREFIX} Attempting to recreate dead worker ${i}...`);
                const newWorker = await mediasoup.createWorker(mediasoupOptions.worker);
                workers[i] = newWorker;
                workerLoadCount.set(newWorker, 0);
                console.log(`${LOG_PREFIX} Worker ${i} recreated successfully with new PID: ${newWorker.pid}`);
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
          console.error(`${LOG_PREFIX} Failed to create mediasoup worker ${i}:`, error);
          return null;
        })
    );
  }
  const results = await Promise.all(workerPromises);
  workers = results.filter((worker) => worker !== null);
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
  if (workers.length === 0) {
    throw new Error(`${LOG_PREFIX} No mediasoup workers available`);
  }
  const sortedWorkers = [...workerLoadCount.entries()].sort((a, b) => a[1] - b[1]);
  const [worker, load] = sortedWorkers[0];
  workerLoadCount.set(worker, load + 1);
  console.log(`${LOG_PREFIX} Selected worker with PID ${worker.pid} (current load: ${load}, new load: ${load + 1})`);
  return worker;
}

function releaseWorker(worker) {
  const currentLoad = workerLoadCount.get(worker) || 0;
  if (currentLoad > 0) {
    workerLoadCount.set(worker, currentLoad - 1);
    console.log(`${LOG_PREFIX} Released worker with PID ${worker.pid} (new load: ${currentLoad - 1})`);
  } else {
    console.warn(`${LOG_PREFIX} Attempted to release worker with PID ${worker.pid} but its load was already 0`);
  }
}

const rooms = new Map();

async function getOrCreateRoom(roomName) {
  console.log(`${LOG_PREFIX} getOrCreateRoom called for roomName: ${roomName}`);
  let room = rooms.get(roomName);
  if (room) {
    console.log(`${LOG_PREFIX} Room ${roomName} already exists, returning existing room`);
    return room;
  }
  if (roomsInCreation.has(roomName)) {
    console.log(`${LOG_PREFIX} Room ${roomName} is currently being created, waiting...`);
    try {
      await roomsInCreation.get(roomName);
      return rooms.get(roomName);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error waiting for room ${roomName} creation:`, error);
      throw error;
    }
  }
  console.log(`${LOG_PREFIX} Creating new room: ${roomName}`);
  const creationPromise = new Promise(async (resolve, reject) => {
    try {
      const worker = getLeastLoadedWorker();
      const router = await worker.createRouter({
        mediaCodecs: mediasoupOptions.router.mediaCodecs,
      });
      console.log(`${LOG_PREFIX} Router created for room ${roomName} on worker PID ${worker.pid}`);
      room = {
        id: roomName,
        router,
        worker,
        peers: new Map(),
        creationTime: Date.now(),
      };
      rooms.set(roomName, room);
      console.log(`${LOG_PREFIX} Room ${roomName} created successfully`);
      resolve(room);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating room ${roomName}:`, error);
      reject(error);
    } finally {
      roomsInCreation.delete(roomName);
      console.log(`${LOG_PREFIX} Cleanup for room creation promise of room ${roomName}`);
    }
  });
  roomsInCreation.set(roomName, creationPromise);
  return creationPromise;
}

async function createWebRtcTransport(router) {
  console.log(`${LOG_PREFIX} createWebRtcTransport called on router with id: ${router.id}`);
  const { listenIps, initialAvailableOutgoingBitrate, maxIncomingBitrate } = mediasoupOptions.webRtcTransport;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const errorMsg = `${LOG_PREFIX} Timeout creating WebRTC transport`;
      console.error(errorMsg);
      reject(new Error(errorMsg));
    }, 10000);
    try {
      console.log(`${LOG_PREFIX} Creating WebRTC transport with options:`, {
        listenIps,
        initialAvailableOutgoingBitrate,
        maxIncomingBitrate,
      });
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
            { urls: "stun:stun.stunprotocol.org:3478" },
          ],
        },
      };
      router
        .createWebRtcTransport(transportOptions)
        .then(async (transport) => {
          clearTimeout(timeout);
          console.log(`${LOG_PREFIX} WebRTC transport created with ID: ${transport.id}`);
          try {
            if (maxIncomingBitrate) {
              await transport.setMaxIncomingBitrate(maxIncomingBitrate);
              console.log(`${LOG_PREFIX} Set max incoming bitrate to ${maxIncomingBitrate} on transport ${transport.id}`);
            }
            transport.on("routerclose", () => {
              console.log(`${LOG_PREFIX} Transport ${transport.id} closed due to router closure`);
            });
            transport.on("icestatechange", (iceState) => {
              console.log(`${LOG_PREFIX} Transport ${transport.id} ICE state changed to ${iceState}`);
              if (iceState === "failed") {
                console.warn(`${LOG_PREFIX} ICE failed for transport ${transport.id}, attempting restart`);
                transport.restartIce()
                  .then(() => console.log(`${LOG_PREFIX} ICE restarted for transport ${transport.id}`))
                  .catch((error) => console.error(`${LOG_PREFIX} Error restarting ICE for transport ${transport.id}: ${error}`));
              }
            });
            transport.on("dtlsstatechange", (dtlsState) => {
              console.log(`${LOG_PREFIX} Transport ${transport.id} DTLS state changed to ${dtlsState}`);
              if (dtlsState === "failed" || dtlsState === "closed") {
                console.error(`${LOG_PREFIX} Transport ${transport.id} DTLS state is ${dtlsState}`);
              }
            });
            transport.on("sctpstatechange", (sctpState) => {
              console.log(`${LOG_PREFIX} Transport ${transport.id} SCTP state changed to ${sctpState}`);
            });
            resolve({
              transport,
              params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                sctpParameters: transport.sctpParameters,
              },
            });
          } catch (error) {
            clearTimeout(timeout);
            console.error(`${LOG_PREFIX} Error during WebRTC transport setup:`, error);
            reject(error);
          }
        })
        .catch((error) => {
          clearTimeout(timeout);
          console.error(`${LOG_PREFIX} Error creating WebRTC transport:`, error);
          reject(error);
        });
    } catch (error) {
      clearTimeout(timeout);
      console.error(`${LOG_PREFIX} Exception in createWebRtcTransport:`, error);
      reject(error);
    }
  });
}

// ------------------------------
// Socket / Room Management
// ------------------------------
function getPeerForSocket(socket) {
  const roomName = socket.data.roomName;
  if (!roomName) {
    console.warn(`${LOG_PREFIX} getPeerForSocket: No roomName for socket ${socket.id}`);
    return null;
  }
  const room = rooms.get(roomName);
  if (!room) {
    console.warn(`${LOG_PREFIX} getPeerForSocket: Room ${roomName} not found for socket ${socket.id}`);
    return null;
  }
  return room.peers.get(socket.id);
}

async function closeAndCleanupRoom(roomName) {
  console.log(`${LOG_PREFIX} Closing and cleaning up room ${roomName}`);
  const room = rooms.get(roomName);
  if (!room) {
    console.warn(`${LOG_PREFIX} Room ${roomName} not found during cleanup`);
    return;
  }
  try {
    room.router.close();
    console.log(`${LOG_PREFIX} Closed router for room ${roomName}`);
  } catch (e) {
    console.error(`${LOG_PREFIX} Error closing router for room ${roomName}:`, e);
  }
  releaseWorker(room.worker);
  rooms.delete(roomName);
  console.log(`${LOG_PREFIX} Room ${roomName} removed from active rooms`);
}

setInterval(() => {
  console.log(`${LOG_PREFIX} Running periodic room cleanup...`);
  const now = Date.now();
  for (const [roomName, room] of rooms.entries()) {
    if (room.peers.size === 0 && now - room.creationTime > 60 * 60 * 1000) {
      console.log(`${LOG_PREFIX} Room ${roomName} is empty and older than 1 hour. Cleaning up.`);
      closeAndCleanupRoom(roomName);
    }
  }
}, 15 * 60 * 1000);

const activeSockets = new Map();

io.on("connection", (socket) => {
  console.log(`${LOG_PREFIX} New socket connection established: ${socket.id}`);
  activeSockets.set(socket.id, {
    socket,
    lastActivity: Date.now(),
    roomName: null,
  });
  socket.on("disconnect", (reason) => {
    console.log(`${LOG_PREFIX} Socket ${socket.id} disconnected. Reason: ${reason}`);
    handleUserLeaving(socket);
    activeSockets.delete(socket.id);
  });
  socket.on("error", (error) => {
    console.error(`${LOG_PREFIX} Socket ${socket.id} encountered an error:`, error);
  });
  socket.on("ping", (callback) => {
    console.log(`${LOG_PREFIX} Ping received from socket ${socket.id}`);
    if (typeof callback === "function") {
      callback();
    }
  });
  socket.on("heartbeat", () => {
    if (activeSockets.has(socket.id)) {
      const socketData = activeSockets.get(socket.id);
      socketData.lastActivity = Date.now();
      activeSockets.set(socket.id, socketData);
      console.log(`${LOG_PREFIX} Heartbeat received from socket ${socket.id}`);
    }
  });

  socket.data = {};

  socket.on("joinRoom", async ({ roomName, userId, userName, userEmail }, callback) => {
    console.log(`${LOG_PREFIX} joinRoom event received from socket ${socket.id} for room ${roomName}`);
    if (!roomName) {
      console.error(`${LOG_PREFIX} Room name is undefined`);
      socket.emit("error", { message: "Room name is required" });
      return;
    }
    socket.data.roomName = roomName;
    socket.data.userId = userId;
    socket.data.userName = userName;
    socket.data.userEmail = userEmail;
    try {
      const room = await getOrCreateRoom(roomName);
      room.peers.set(socket.id, {
        socket,
        transports: {},
        producers: new Map(),
        consumers: new Map(),
        userId,
        userName,
        userEmail,
      });
      socket.join(roomName);
      console.log(`${LOG_PREFIX} User ${userId} (${userName}, ${userEmail}) joined room ${roomName}`);
      const roomParticipants = [];
      for (const [_, peer] of room.peers.entries()) {
        if (peer.userId !== userId) {
          roomParticipants.push({
            userId: peer.userId,
            userName: peer.userName,
            userInitials: peer.userName.substring(0, 2),
          });
        }
      }
      console.log(`${LOG_PREFIX} Room ${roomName} participants:`, roomParticipants);
      socket.emit("roomUsers", roomParticipants);
      socket.to(roomName).emit("userJoined", {
        userId,
        userName,
        userInitials: userName.substring(0, 2),
      });
      // Send router RTP capabilities using toJSON() if available.
      const rtpCaps =
        room.router.rtpCapabilities &&
        typeof room.router.rtpCapabilities.toJSON === "function"
          ? room.router.rtpCapabilities.toJSON()
          : room.router.rtpCapabilities;
      console.log(`${LOG_PREFIX} Sending router RTP capabilities:`, rtpCaps);
      callback({ rtpCapabilities: rtpCaps });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error joining room ${roomName} for socket ${socket.id}:`, error);
      socket.emit("error", { message: "Failed to join room", error: error.message });
    }
  });

  socket.on("restartIce", async ({ transportId }) => {
    console.log(`${LOG_PREFIX} restartIce event for transport ${transportId} from socket ${socket.id}`);
    try {
      const { roomName } = socket.data;
      const room = rooms.get(roomName);
      if (!room) {
        console.error(`${LOG_PREFIX} Room ${roomName} not found for socket ${socket.id}`);
        socket.emit("error", { message: "Room not found" });
        return;
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`${LOG_PREFIX} Peer not found for socket ${socket.id} in room ${roomName}`);
        socket.emit("error", { message: "Peer not found" });
        return;
      }
      const transport = peer.transports[transportId];
      if (!transport) {
        console.error(`${LOG_PREFIX} Transport ${transportId} not found for socket ${socket.id}`);
        socket.emit("error", { message: "Transport not found" });
        return;
      }
      console.log(`${LOG_PREFIX} Restarting ICE for transport ${transportId}...`);
      const iceParameters = await transport.restartIce();
      console.log(`${LOG_PREFIX} ICE restarted for transport ${transportId}`);
      socket.emit("iceRestarted", { transportId, iceParameters });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error restarting ICE for transport ${transportId} on socket ${socket.id}:`, error);
      socket.emit("error", { message: "Failed to restart ICE", error: error.message });
    }
  });
});

// Helper: handleUserLeaving
function handleUserLeaving(socket) {
  const roomName = socket.data.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (!room) return;
  const peer = room.peers.get(socket.id);
  if (!peer) return;
  socket.to(roomName).emit("userLeft", { userId: socket.data.userId });
  // Close all transports.
  for (const key in peer.transports) {
    try {
      peer.transports[key].close();
    } catch (e) {
      console.error(`${LOG_PREFIX} Error closing transport ${key} for socket ${socket.id}:`, e);
    }
  }
  // Close producers and inform other clients.
  peer.producers.forEach((producer) => {
    try {
      producer.close();
    } catch (e) {
      console.error(`${LOG_PREFIX} Error closing producer ${producer.id} for socket ${socket.id}:`, e);
    }
    socket.to(roomName).emit("producerClosed", {
      remoteProducerId: producer.id,
      userId: socket.data.userId,
    });
  });
  // Close consumers.
  peer.consumers.forEach((consumer) => {
    try {
      consumer.close();
    } catch (e) {
      console.error(`${LOG_PREFIX} Error closing consumer ${consumer.id} for socket ${socket.id}:`, e);
    }
  });
  room.peers.delete(socket.id);
  socket.leave(roomName);
  console.log(`${LOG_PREFIX} User ${socket.data.userId} removed from room ${roomName}`);
  if (room.peers.size === 0) {
    console.log(`${LOG_PREFIX} Room ${roomName} is now empty. Initiating cleanup.`);
    closeAndCleanupRoom(roomName);
  }
}

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`${LOG_PREFIX} Server is running on port ${PORT}`);
  console.log(`${LOG_PREFIX} Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`${LOG_PREFIX} Workers count: ${workers.length}`);
  console.log(`${LOG_PREFIX} Announced IP: ${process.env.ANNOUNCED_IP || "default"}`);
  console.log(`${LOG_PREFIX} CORS setting: ${process.env.CORS_ORIGIN || "all origins"}`);
  console.log(`${LOG_PREFIX} Available endpoints:`);
  console.log(`${LOG_PREFIX} - GET /health`);
  console.log(`${LOG_PREFIX} - GET /`);
  console.log(`${LOG_PREFIX} - WebSocket (Socket.io) connection`);
});

server.on("error", (error) => {
  console.error(`${LOG_PREFIX} Server encountered an error:`, error);
});

process.on("SIGINT", () => {
  console.log(`${LOG_PREFIX} Received SIGINT, shutting down gracefully`);
  cleanupAndExit();
});

process.on("SIGTERM", () => {
  console.log(`${LOG_PREFIX} Received SIGTERM, shutting down gracefully`);
  cleanupAndExit();
});

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

io.on("error", (error) => {
  console.error(`${LOG_PREFIX} Socket.io server error:`, error);
});

io.engine.on("connection_error", (err) => {
  console.error(`${LOG_PREFIX} Socket.io connection error:`, err);
});
