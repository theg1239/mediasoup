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
  transports: ["websocket", "polling"]
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
    workerLoadCount.set(worker, current - 1);
    console.log(`${LOG_PREFIX} Released worker PID ${worker.pid} (new load: ${current - 1})`);
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
      const worker = getLeastLoadedWorker();
      const router = await worker.createRouter({ mediaCodecs: mediasoupOptions.router.mediaCodecs });
      console.log(`${LOG_PREFIX} Router created for room ${roomName} on worker PID ${worker.pid}`);
      room = {
        id: roomName,
        router,
        worker,
        peers: new Map(),
        creationTime: Date.now()
      };
      rooms.set(roomName, room);
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

  // joinRoom: add peer to room, send back RTP capabilities and notify others.
  socket.on("joinRoom", async (data, callback) => {
    try {
      const { roomName, userId, userName, userEmail } = data;
      if (!roomName) throw new Error("Room name is required");
      socket.data.roomName = roomName;
      socket.data.userId = userId;
      socket.data.userName = userName;
      socket.data.userEmail = userEmail;
      
      const room = await getOrCreateRoom(roomName);
      
      room.peers.set(socket.id, {
        socket,
        transports: {},
        producers: new Map(),
        consumers: new Map(),
        userId,
        userName,
        userEmail,
        deviceReady: false
      });
      
      socket.join(roomName);
      console.log(`${LOG_PREFIX} User ${userId} (${userName}) joined room ${roomName}`);

      // Build participants list (excluding current user)
      const participants = [];
      for (const [id, peer] of room.peers.entries()) {
        if (peer.userId !== userId) {
          participants.push({
            userId: peer.userId,
            userName: peer.userName,
            userInitials: peer.userName.substring(0, 2)
          });
        }
      }
      socket.emit("roomUsers", participants);

      // Collect existing producers from all peers
      const existingProducers = [];
      for (const [id, peer] of room.peers.entries()) {
        if (peer.socket.id !== socket.id) {
          for (const [producerId, producer] of peer.producers.entries()) {
            existingProducers.push({
              producerId,
              producerUserId: peer.userId,
              kind: producer.kind,
              rtpParameters: producer.rtpParameters
            });
          }
        }
      }

      const rtpCaps = (room.router &&
        typeof room.router.rtpCapabilities.toJSON === "function")
        ? room.router.rtpCapabilities.toJSON()
        : room.router.rtpCapabilities;
      
      console.log(`${LOG_PREFIX} Sending router RTP capabilities:`, rtpCaps);
      callback({ rtpCapabilities: rtpCaps, existingProducers });
      
      // Notify others about the new user
      socket.to(roomName).emit("userJoined", {
        userId,
        userName,
        userInitials: userName.substring(0, 2)
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} joinRoom error:`, error);
      socket.emit("error", { message: "Failed to join room", error: error.message });
    }
  });

  socket.on("createWebRtcTransport", async (data, callback) => {
    try {
      const room = rooms.get(socket.data.roomName);
      if (!room) {
        console.error(`${LOG_PREFIX} Room not found for user ${socket.data.userId}`);
        if (typeof callback === 'function') {
          callback({ error: "Room not found" });
        }
        return;
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`${LOG_PREFIX} Peer not found for user ${socket.data.userId}`);
        if (typeof callback === 'function') {
          callback({ error: "Peer not found" });
        }
        return;
      }

      console.log(`${LOG_PREFIX} Creating WebRTC transport for user ${socket.data.userId}`);
      const transport = await createWebRtcTransport(room.router);
      
      peer.transports[transport.transport.id] = transport.transport;
      console.log(`${LOG_PREFIX} WebRTC transport created: ${transport.transport.id}`);
      
      if (typeof callback === 'function') {
        callback({
          params: {
            id: transport.transport.id,
            iceParameters: transport.transport.iceParameters,
            iceCandidates: transport.transport.iceCandidates,
            dtlsParameters: transport.transport.dtlsParameters,
            sctpParameters: transport.transport.sctpParameters
          }
        });
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating WebRTC transport:`, error);
      if (typeof callback === 'function') {
        callback({ error: error.message });
      }
    }
  });

  // Add deviceReady handler
  socket.on("deviceReady", async () => {
    try {
      const room = rooms.get(socket.data.roomName);
      if (!room) throw new Error("Room not found");
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");

      console.log(`${LOG_PREFIX} Device ready for user ${socket.data.userId}`);
      peer.deviceReady = true;

      // Collect existing producers
      const existingProducers = [];
      for (const [id, otherPeer] of room.peers.entries()) {
        if (otherPeer.socket.id !== socket.id) {
          for (const [producerId, producer] of otherPeer.producers.entries()) {
            existingProducers.push({
              producerId,
              producerUserId: otherPeer.userId,
              kind: producer.kind,
              rtpParameters: producer.rtpParameters
            });
          }
        }
      }

      // Create consumer transports for existing producers
      for (const producerInfo of existingProducers) {
        try {
          const transport = await createWebRtcTransport(room.router);
          peer.transports[transport.transport.id] = transport.transport;
          
          // Emit the event with transport parameters and a callback
          socket.emit("createWebRtcTransport", 
            { 
              consumer: true,
              params: transport.params
            }, 
            (response) => {
              if (response && response.error) {
                console.error(`${LOG_PREFIX} Error in createWebRtcTransport callback:`, response.error);
              }
            }
          );
          
          const consumer = await transport.transport.consume({
            producerId: producerInfo.producerId,
            rtpCapabilities: room.router.rtpCapabilities
          });
          
          peer.consumers.set(consumer.id, consumer);
          
          socket.emit("consume", {
            id: consumer.id,
            producerId: producerInfo.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            serverConsumerId: consumer.id
          });
        } catch (error) {
          console.error(`${LOG_PREFIX} Error creating consumer for existing producer:`, error);
        }
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Error handling deviceReady:`, error);
    }
  });

  socket.on("chatMessage", (data) => {
    try {
      const room = rooms.get(socket.data.roomName);
      if (!room) throw new Error("Room not found");

      const { roomId, userId, userName, message } = data;
      console.log(`${LOG_PREFIX} Chat message from ${userName}: ${message}`);

      io.to(roomId).emit("chatMessage", {
        userId,
        userName,
        message,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error handling chat message:`, error);
    }
  });

  socket.on("getRouterRtpCapabilities", (data, callback) => {
    const room = rooms.get(socket.data.roomName);
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
      const room = rooms.get(socket.data.roomName);
      if (!room) throw new Error("Room not found");
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");
      
      const transport = peer.transports[data.transportId];
      if (!transport) throw new Error("Transport not found");
      
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    } catch (error) {
      callback({ error: error.message });
    }
  });

  // transport-produce: create a producer
  socket.on("transport-produce", async (data, callback) => {
    try {
      const room = rooms.get(socket.data.roomName);
      if (!room) throw new Error("Room not found");
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");
      
      const transport = peer.transports[data.transportId];
      if (!transport) throw new Error("Transport not found");
      
      console.log(`${LOG_PREFIX} Creating producer for user ${socket.data.userId} with kind ${data.kind}`);
      
      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: data.appData
      });
      
      peer.producers.set(producer.id, producer);
      console.log(`${LOG_PREFIX} Producer created: ${producer.id} for user ${socket.data.userId}`);
      
      // Notify other users about the new producer
      socket.to(socket.data.roomName).emit("new-producer", {
        producerId: producer.id,
        producerUserId: socket.data.userId,
        kind: producer.kind
      });
      
      callback({ id: producer.id });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating producer:`, error);
      callback({ error: error.message });
    }
  });

  // transport-recv-connect: acknowledge consumer transport connection
  socket.on("transport-recv-connect", async (data, callback) => {
    try {
      const room = rooms.get(socket.data.roomName);
      if (!room) throw new Error("Room not found");
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");
      
      const transport = peer.transports[data.serverConsumerTransportId];
      if (!transport) throw new Error("Consumer transport not found");
      
      console.log(`${LOG_PREFIX} Connecting consumer transport ${data.serverConsumerTransportId} for user ${socket.data.userId}`);
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    } catch (error) {
      console.error(`${LOG_PREFIX} Error connecting consumer transport:`, error);
      callback({ error: error.message });
    }
  });

  // consume: create a consumer for a remote producer
  socket.on("consume", async (data, callback) => {
    try {
      const room = rooms.get(socket.data.roomName);
      if (!room) throw new Error("Room not found");
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");
      
      const consumerTransport = peer.transports[data.serverConsumerTransportId];
      if (!consumerTransport) throw new Error("Consumer transport not found");
      
      console.log(`${LOG_PREFIX} Creating consumer for producer ${data.remoteProducerId} for user ${socket.data.userId}`);
      
      const consumer = await consumerTransport.consume({
        producerId: data.remoteProducerId,
        rtpCapabilities: data.rtpCapabilities
      });
      
      peer.consumers.set(consumer.id, consumer);
      console.log(`${LOG_PREFIX} Consumer created: ${consumer.id} for user ${socket.data.userId}`);
      
      callback({
        id: consumer.id,
        producerId: data.remoteProducerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        serverConsumerId: consumer.id
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating consumer:`, error);
      callback({ error: error.message });
    }
  });

  // consumer-resume: acknowledge resume
  socket.on("consumer-resume", async (data, callback) => {
    try {
      const room = rooms.get(socket.data.roomName);
      if (!room) throw new Error("Room not found");
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");
      
      const consumer = peer.consumers.get(data.serverConsumerId);
      if (!consumer) throw new Error("Consumer not found");
      
      await consumer.resume();
      callback();
    } catch (error) {
      callback({ error: error.message });
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
  const roomName = socket.data.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (!room) return;
  socket.to(roomName).emit("userLeft", { userId: socket.data.userId });
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
      socket.to(roomName).emit("producerClosed", { remoteProducerId: producer.id, userId: socket.data.userId });
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
  console.log(`${LOG_PREFIX} User ${socket.data.userId} left room ${roomName}`);
  if (room.peers.size === 0) {
    console.log(`${LOG_PREFIX} Room ${roomName} is empty. Cleaning up.`);
    closeAndCleanupRoom(roomName);
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