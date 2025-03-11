const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os');

const app = express();

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = ['http://localhost:3000', process.env.FRONTEND_URL || '*'];
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send(`
    <h1>MediaSoup WebRTC Server</h1>
    <p>Server is running</p>
    <p>Environment: ${process.env.NODE_ENV || 'development'}</p>
    <p>Workers: ${workers.length}</p>
    <p>Active rooms: ${rooms.size}</p>
    <p>Socket.io is available at: <code>${req.protocol}://${req.get('host')}</code></p>
    <p>Health check endpoint: <code>${req.protocol}://${req.get('host')}/health</code></p>
  `);
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: corsOptions,
  pingTimeout: 60000, // Longer ping timeout
  pingInterval: 25000, // More frequent pings
  transports: ['websocket', 'polling'] // Support both WebSocket and polling for better compatibility
});

function getListenIps() {
  const interfaces = os.networkInterfaces();
  const listenIps = [];
  
  let publicIp = process.env.ANNOUNCED_IP;
  
  if (process.env.DYNO) {
    console.log('Running on Heroku, using 0.0.0.0 with null announced IP');
    listenIps.push({ 
      ip: '0.0.0.0', 
      announcedIp: null
    });
    return listenIps;
  }
  
  listenIps.push({ 
    ip: '0.0.0.0', 
    announcedIp: publicIp || null
  });
  
  if (!publicIp) {
    console.warn('WARNING: No ANNOUNCED_IP environment variable set. WebRTC may not work correctly from remote clients.');
  }
  
  return listenIps;
}

const mediasoupOptions = {
  worker: {
    rtcMinPort: process.env.RTC_MIN_PORT || 40000,
    rtcMaxPort: process.env.RTC_MAX_PORT || 49999,
    logLevel: process.env.LOG_LEVEL || 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
  },
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: { 
          'x-google-start-bitrate': 1000,
          'x-google-min-bitrate': 600,
          'x-google-max-bitrate': 3000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: { 
          'x-google-start-bitrate': 1000,
          'profile-id': 2,
          'x-google-min-bitrate': 600,
          'x-google-max-bitrate': 3000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000,
          'x-google-min-bitrate': 600,
          'x-google-max-bitrate': 3000
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

const roomsInCreation = new Map();

let workers = [];
const workerLoadCount = new Map();

async function createWorkers() {
  const numWorkers = process.env.NUM_WORKERS ? parseInt(process.env.NUM_WORKERS, 10) : 1;
  const coreCount = os.cpus().length;
  const count = Math.min(numWorkers, coreCount);
  
  console.log(`Creating ${count} mediasoup workers...`);
  
  const workerPromises = [];
  
  for (let i = 0; i < count; i++) {
    workerPromises.push(
      mediasoup.createWorker(mediasoupOptions.worker)
        .then(worker => {
          console.log(`Mediasoup Worker ${i} created`);
          
          worker.on('died', (error) => {
            console.error(`Mediasoup Worker ${i} died with error: ${error.message}`);
            
            setTimeout(async () => {
              try {
                console.log(`Attempting to recreate dead worker ${i}...`);
                const newWorker = await mediasoup.createWorker(mediasoupOptions.worker);
                
                workers[i] = newWorker;
                workerLoadCount.set(newWorker, 0);
                
                console.log(`Worker ${i} recreated successfully`);
              } catch (err) {
                console.error(`Failed to recreate worker ${i}:`, err);
              }
            }, 2000);
          });
          
          workers[i] = worker;
          workerLoadCount.set(worker, 0);
          return worker;
        })
        .catch(error => {
          console.error(`Failed to create mediasoup worker ${i}:`, error);
          return null;
        })
    );
  }
  
  const results = await Promise.all(workerPromises);
  
  workers = results.filter(worker => worker !== null);
  
  if (workers.length === 0) {
    throw new Error('Failed to create any mediasoup workers');
  }
  
  console.log(`Created ${workers.length} mediasoup workers successfully`);
}

(async () => {
  try {
    await createWorkers();
  } catch (err) {
    console.error('Failed to create mediasoup workers:', err);
    process.exit(1);
  }
})();

function getLeastLoadedWorker() {
  if (workers.length === 0) {
    throw new Error('No mediasoup workers available');
  }
  
  const sortedWorkers = [...workerLoadCount.entries()]
    .sort((a, b) => a[1] - b[1]);
  
  const [worker, load] = sortedWorkers[0];
  workerLoadCount.set(worker, load + 1);
  
  return worker;
}

function releaseWorker(worker) {
  const currentLoad = workerLoadCount.get(worker) || 0;
  if (currentLoad > 0) {
    workerLoadCount.set(worker, currentLoad - 1);
  }
}

const rooms = new Map();

async function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;
  
  if (roomsInCreation.has(roomId)) {
    console.log(`Room ${roomId} is being created, waiting...`);
    try {
      await roomsInCreation.get(roomId);
      return rooms.get(roomId);
    } catch (error) {
      console.error(`Error waiting for room ${roomId} to be created:`, error);
      throw error;
    }
  }
  
  console.log(`Attempting to create room ${roomId}`);
  
  const creationPromise = new Promise(async (resolve, reject) => {
    try {
      const worker = getLeastLoadedWorker();
      const router = await worker.createRouter({
        mediaCodecs: mediasoupOptions.router.mediaCodecs
      });
      
      const room = { 
        id: roomId, 
        router, 
        worker,
        peers: new Map(),
        creationTime: Date.now()
      };
      
      rooms.set(roomId, room);
      console.log(`Room ${roomId} created successfully`);
      resolve(room);
    } catch (error) {
      console.error('Error creating room:', error);
      reject(error);
    } finally {
      // Remove from in-progress map
      roomsInCreation.delete(roomId);
    }
  });
  
  // Store the promise in the in-progress map
  roomsInCreation.set(roomId, creationPromise);
  
  // Wait for the room to be created
  return creationPromise;
}

async function createWebRtcTransport(router) {
  const {
    listenIps,
    initialAvailableOutgoingBitrate,
    maxIncomingBitrate
  } = mediasoupOptions.webRtcTransport;
  
  // Set a timeout for transport creation
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout creating WebRTC transport'));
    }, 10000);
    
    try {
      // Add more options for better connectivity
      const transportOptions = {
        listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate,
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        maxSctpMessageSize: 262144,
        // Add ICE timeout settings
        iceConsentTimeout: 60, // seconds
        iceRetransmissionTimeout: 1000, // ms
        // Add additional ICE settings
        additionalSettings: {
          iceTransportPolicy: 'all',
          iceCandidatePoolSize: 10,
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.stunprotocol.org:3478' }
          ]
        }
      };
      
      router.createWebRtcTransport(transportOptions).then(async (transport) => {
        clearTimeout(timeout);
        
        try {
          if (maxIncomingBitrate) {
            await transport.setMaxIncomingBitrate(maxIncomingBitrate);
          }
          
          // Log transport creation
          console.log(`Transport created with ID: ${transport.id}`);
          
          // Monitor transport for close events
          transport.on('routerclose', () => {
            console.log(`Transport ${transport.id} closed because router closed`);
          });
          
          transport.on('icestatechange', (iceState) => {
            console.log(`Transport ${transport.id} ICE state changed to ${iceState}`);
            
            // If ICE fails, try to restart it
            if (iceState === 'failed') {
              console.log(`Attempting to restart ICE for transport ${transport.id}`);
              try {
                transport.restartIce()
                  .then(() => console.log(`ICE restarted for transport ${transport.id}`))
                  .catch(error => console.error(`Error restarting ICE: ${error}`));
              } catch (error) {
                console.error(`Error attempting to restart ICE: ${error}`);
              }
            }
          });
          
          transport.on('dtlsstatechange', (dtlsState) => {
            console.log(`Transport ${transport.id} DTLS state changed to ${dtlsState}`);
            
            // If the state is 'failed' or 'closed', log it
            if (dtlsState === 'failed' || dtlsState === 'closed') {
              console.error(`Transport ${transport.id} DTLS state is ${dtlsState}`);
            }
          });
          
          transport.on('sctpstatechange', (sctpState) => {
            console.log(`Transport ${transport.id} SCTP state changed to ${sctpState}`);
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
        } catch (error) {
          clearTimeout(timeout);
          console.error('Error setting up transport:', error);
          reject(error);
        }
      }).catch((error) => {
        clearTimeout(timeout);
        console.error('Error creating WebRTC transport:', error);
        reject(error);
      });
    } catch (error) {
      clearTimeout(timeout);
      console.error('Error in createWebRtcTransport:', error);
      reject(error);
    }
  });
}

// Helper to get a peer for a socket
function getPeerForSocket(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return null;
  
  const room = rooms.get(roomId);
  if (!room) return null;
  
  return room.peers.get(socket.id);
}

async function closeAndCleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  console.log(`Closing and cleaning up room ${roomId}`);
  
  try {
    room.router.close();
  } catch (e) {
    console.error(`Error closing router for room ${roomId}:`, e);
  }
  
  releaseWorker(room.worker);
  
  rooms.delete(roomId);
  
  console.log(`Room ${roomId} closed and cleaned up`);
}

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.peers.size === 0 && now - room.creationTime > 60 * 60 * 1000) {
      console.log(`Room ${roomId} is empty and old. Cleaning up.`);
      closeAndCleanupRoom(roomId);
    }
  }
}, 15 * 60 * 1000);

const activeSockets = new Map();

io.on('connection', (socket) => {
  console.log(`New socket connection: ${socket.id}`);
  
  // Track active sockets
  activeSockets.set(socket.id, {
    socket,
    lastActivity: Date.now(),
    roomId: null
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`Socket ${socket.id} disconnected: ${reason}`);
    handleUserLeaving(socket);
    activeSockets.delete(socket.id);
  });
  
  socket.on('error', (error) => {
    console.error(`Socket ${socket.id} error:`, error);
  });
  
  socket.on('ping', (callback) => {
    if (typeof callback === 'function') {
      callback();
    }
  });
  
  socket.on('heartbeat', () => {
    if (activeSockets.has(socket.id)) {
      const socketData = activeSockets.get(socket.id);
      socketData.lastActivity = Date.now();
      activeSockets.set(socket.id, socketData);
    }
  });

  socket.data = {};

  socket.on('joinRoom', async ({ roomId, userId, userName, userEmail }) => {
    console.log(`joinRoom event received from socket ${socket.id} for room ${roomId}`);
    socket.data.roomId = roomId;
    socket.data.userId = userId;
    socket.data.userName = userName;
    socket.data.userEmail = userEmail;
    
    try {
      const room = await getOrCreateRoom(roomId);
      
      room.peers.set(socket.id, {
        socket,
        transports: {},
        producers: new Map(),
        consumers: new Map(),
        userId,
        userName,
        userEmail
      });
      
      socket.join(roomId);
      console.log(`User ${userId} (${userName}, ${userEmail}) joined room ${roomId}`);
      
      const roomParticipants = [];
      for (const [_, peer] of room.peers.entries()) {
        if (peer.userId !== userId) {
          roomParticipants.push({
            userId: peer.userId,
            userName: peer.userName,
            userInitials: peer.userName.substring(0, 2)
          });
        }
      }
      
      socket.emit('roomUsers', roomParticipants);
      
      socket.to(roomId).emit('userJoined', {
        userId,
        userName,
        userInitials: userName.substring(0, 2)
      });
      
      socket.emit('routerRtpCapabilities', room.router.rtpCapabilities);
    } catch (error) {
      console.error(`Error joining room ${roomId}:`, error);
      socket.emit('error', { message: 'Failed to join room', error: error.message });
    }
  });

  socket.on('getRouterRtpCapabilities', async () => {
    console.log(`getRouterRtpCapabilities requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    
    try {
      const room = await getOrCreateRoom(roomId);
      
      if (!room) {
        console.error(`No room found for socket ${socket.id}`);
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      socket.emit('routerRtpCapabilities', room.router.rtpCapabilities);
      console.log(`Sent router RTP capabilities to socket ${socket.id}`);
    } catch (error) {
      console.error(`Error getting router capabilities: ${error}`);
      socket.emit('error', { message: 'Failed to get router capabilities', error: error.message });
    }
  });

  socket.on('createProducerTransport', async ({ forceTcp, rtpCapabilities }, callback) => {
    console.log(`createProducerTransport requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    
    try {
      const room = await getOrCreateRoom(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        if (callback) {
          callback({ error: 'Room not found' });
        } else {
          socket.emit('error', { message: 'Room not found' });
        }
        return;
      }
      
      const transportOptions = { ...mediasoupOptions.webRtcTransport };
      if (forceTcp) {
        transportOptions.enableUdp = false;
        transportOptions.enableTcp = true;
      }
      
      // Set a timeout for transport creation
      const transportCreationTimeout = setTimeout(() => {
        console.error(`Transport creation timed out for socket ${socket.id}`);
        if (callback) {
          callback({ error: 'Transport creation timed out' });
        } else {
          socket.emit('error', { message: 'Transport creation timed out' });
        }
      }, 15000);
      
      try {
        const { transport, params } = await createWebRtcTransport(room.router);
        
        clearTimeout(transportCreationTimeout);
        
        const peer = room.peers.get(socket.id);
        if (!peer) {
          console.error(`Peer not found for socket ${socket.id}`);
          if (callback) {
            callback({ error: 'Peer not found' });
          } else {
            socket.emit('error', { message: 'Peer not found' });
          }
          return;
        }
        
        // Store the transport
        peer.transports[transport.id] = transport;
        
        console.log(`Producer transport created for user ${socket.data.userId} on socket ${socket.id}`);
        
        // Send the transport parameters back to the client
        if (callback) {
          callback(params);
        } else {
          socket.emit('producerTransportCreated', params);
        }
      } catch (transportError) {
        clearTimeout(transportCreationTimeout);
        console.error(`Error creating transport: ${transportError}`);
        if (callback) {
          callback({ error: transportError.message });
        } else {
          socket.emit('error', { message: 'Failed to create transport', error: transportError.message });
        }
      }
    } catch (error) {
      console.error(`Error creating producer transport: ${error}`);
      if (callback) {
        callback({ error: error.message });
      } else {
        socket.emit('error', { message: 'Failed to create producer transport', error: error.message });
      }
    }
  });

  socket.on('connectProducerTransport', async ({ dtlsParameters, transportId }) => {
    console.log(`connectProducerTransport requested by socket ${socket.id} for transport ${transportId}`);
    
    try {
      const { roomId } = socket.data;
      const room = rooms.get(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      const peer = room.peers.get(socket.id);
      
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
        socket.emit('error', { message: 'Peer not found' });
        return;
      }
      
      const transport = peer.transports[transportId];
      
      if (!transport) {
        console.error(`Transport ${transportId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Transport not found' });
        return;
      }
      
      // Set a timeout for the connection
      const connectionTimeout = setTimeout(() => {
        console.error(`Transport ${transportId} connection timed out`);
        socket.emit('error', { message: 'Transport connection timed out' });
      }, 30000);
      
      await transport.connect({ dtlsParameters });
      
      clearTimeout(connectionTimeout);
      
      console.log(`Producer transport ${transportId} connected for socket ${socket.id}`);
      socket.emit('producerTransportConnected');
    } catch (error) {
      console.error(`Error connecting producer transport for socket ${socket.id}:`, error);
      socket.emit('error', { message: 'Failed to connect producer transport', error: error.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    console.log(`produce requested by socket ${socket.id} for transport ${transportId} (${kind})`);
    
    try {
      const { roomId } = socket.data;
      const room = rooms.get(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        if (callback) {
          callback({ error: 'Room not found' });
        } else {
          socket.emit('error', { message: 'Room not found' });
        }
        return;
      }
      
      const peer = room.peers.get(socket.id);
      
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
        if (callback) {
          callback({ error: 'Peer not found' });
        } else {
          socket.emit('error', { message: 'Peer not found' });
        }
        return;
      }
      
      const transport = peer.transports[transportId];
      
      if (!transport) {
        console.error(`Transport ${transportId} not found for socket ${socket.id}`);
        if (callback) {
          callback({ error: 'Transport not found' });
        } else {
          socket.emit('error', { message: 'Transport not found' });
        }
        return;
      }
      
      // Set a timeout for the production
      const productionTimeout = setTimeout(() => {
        console.error(`Production for ${kind} on transport ${transportId} timed out`);
        if (callback) {
          callback({ error: 'Production timed out' });
        } else {
          socket.emit('error', { message: 'Production timed out' });
        }
      }, 30000);
      
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { ...appData, peerId: socket.id }
      });
      
      clearTimeout(productionTimeout);
      
      // Store the producer
      peer.producers.set(producer.id, producer);
      
      // Handle producer close
      producer.on('transportclose', () => {
        console.log(`Producer ${producer.id} closed because transport closed`);
        peer.producers.delete(producer.id);
      });
      
      // Notify all other peers in the room about the new producer
      socket.to(roomId).emit('newProducer', {
        producerId: producer.id,
        userId: socket.data.userId,
        kind
      });
      
      console.log(`Producer ${producer.id} created for socket ${socket.id} (${kind})`);
      
      if (callback) {
        callback({ id: producer.id });
      } else {
        socket.emit('producerCreated', { id: producer.id });
      }
    } catch (error) {
      console.error(`Error producing ${kind} for socket ${socket.id}:`, error);
      if (callback) {
        callback({ error: error.message });
      } else {
        socket.emit('error', { message: `Failed to produce ${kind}`, error: error.message });
      }
    }
  });

  socket.on('trickleCandidate', ({ transportId, candidate }) => {
    console.log(`Trickle ICE candidate received for transport ${transportId} from socket ${socket.id}`);
    
    try {
      const { roomId } = socket.data;
      const room = rooms.get(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        return;
      }
      
      const peer = room.peers.get(socket.id);
      
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
        return;
      }
      
      const transport = peer.transports[transportId];
      
      if (!transport) {
        console.error(`Transport ${transportId} not found for socket ${socket.id}`);
        return;
      }
      
      transport.addIceCandidate(candidate)
        .catch(error => {
          console.error(`Error adding ICE candidate for transport ${transportId}:`, error);
        });
    } catch (error) {
      console.error(`Error handling trickle ICE candidate:`, error);
    }
  });

  socket.on('createConsumerTransport', async ({ forceTcp, remoteProducerId }, callback) => {
    console.log(`createConsumerTransport requested by socket ${socket.id} for producer ${remoteProducerId}`);
    const roomId = socket.data.roomId;
    
    try {
      const room = await getOrCreateRoom(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        if (callback) {
          callback({ error: 'Room not found' });
        } else {
          socket.emit('error', { message: 'Room not found' });
        }
        return;
      }
      
      const transportOptions = { ...mediasoupOptions.webRtcTransport };
      if (forceTcp) {
        transportOptions.enableUdp = false;
        transportOptions.enableTcp = true;
      }
      
      const { transport, params } = await createWebRtcTransport(room.router);
      
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id}`);
        if (callback) {
          callback({ error: 'Peer not found' });
        } else {
          socket.emit('error', { message: 'Peer not found' });
        }
        return;
      }
      
      // Store the transport
      peer.transports[transport.id] = transport;
      
      console.log(`Consumer transport created for user ${socket.data.userId} on socket ${socket.id}`);
      
      // Send the transport parameters back to the client
      if (callback) {
        callback({ ...params, remoteProducerId });
      } else {
        socket.emit('consumerTransportCreated', { ...params, remoteProducerId });
      }
    } catch (error) {
      console.error(`Error creating consumer transport: ${error}`);
      if (callback) {
        callback({ error: error.message });
      } else {
        socket.emit('error', { message: 'Failed to create consumer transport', error: error.message });
      }
    }
  });

  socket.on('connectConsumerTransport', async ({ dtlsParameters, transportId }) => {
    console.log(`connectConsumerTransport requested by socket ${socket.id} for transport ${transportId}`);
    
    try {
      const { roomId } = socket.data;
      const room = rooms.get(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      const peer = room.peers.get(socket.id);
      
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
        socket.emit('error', { message: 'Peer not found' });
        return;
      }
      
      const transport = peer.transports[transportId];
      
      if (!transport) {
        console.error(`Transport ${transportId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Transport not found' });
        return;
      }
      
      // Set a timeout for the connection
      const connectionTimeout = setTimeout(() => {
        console.error(`Transport ${transportId} connection timed out`);
        socket.emit('error', { message: 'Transport connection timed out' });
      }, 30000);
      
      await transport.connect({ dtlsParameters });
      
      clearTimeout(connectionTimeout);
      
      console.log(`Consumer transport ${transportId} connected for socket ${socket.id}`);
      socket.emit('consumerTransportConnected');
    } catch (error) {
      console.error(`Error connecting consumer transport for socket ${socket.id}:`, error);
      socket.emit('error', { message: 'Failed to connect consumer transport', error: error.message });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    console.log(`consume event received from socket ${socket.id} for producer ${producerId}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      return callback({ error: 'Room not found' });
    }
    
    const peer = room.peers.get(socket.id);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id}`);
      return callback({ error: 'Peer not found' });
    }
    
    try {
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        console.error(`Cannot consume for socket ${socket.id}, invalid RTP capabilities`);
        return callback({ error: 'Cannot consume with given capabilities' });
      }
      
      const consumerTransport = Object.values(peer.transports).find(t => t.id === transportId);
      if (!consumerTransport) {
        console.error(`Consumer transport ${transportId} not found for socket ${socket.id}`);
        return callback({ error: 'Consumer transport not found' });
      }
      
      const consumer = await consumerTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      });
      
      peer.consumers.set(consumer.id, consumer);
      
      consumer.on('transportclose', () => {
        console.log(`Transport closed for consumer ${consumer.id} on socket ${socket.id}`);
        consumer.close();
        peer.consumers.delete(consumer.id);
      });
      
      consumer.on('producerclose', () => {
        console.log(`Producer closed for consumer ${consumer.id} on socket ${socket.id}`);
        consumer.close();
        peer.consumers.delete(consumer.id);
        
        socket.emit('producerClosed', { 
          remoteProducerId: producerId,
          userId: findUserIdForProducer(producerId, room)
        });
      });
      
      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        peerId: findUserIdForProducer(producerId, room)
      });
      
      try {
        await consumer.resume();
        console.log(`Consumer ${consumer.id} resumed for socket ${socket.id}`);
      } catch (err) {
        console.error(`Error resuming consumer ${consumer.id} for socket ${socket.id}:`, err);
      }
      
    } catch (error) {
      console.error('Consume error for socket', socket.id, error);
      callback({ error: error.message });
    }
  });

  socket.on('closeProducer', ({ producerId }) => {
    console.log(`closeProducer requested for ${producerId} by socket ${socket.id}`);
    const peer = getPeerForSocket(socket);
    if (!peer) return;
    
    const producer = peer.producers.get(producerId);
    if (!producer) return;
    
    producer.close();
    peer.producers.delete(producerId);
    
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit('producerClosed', {
        remoteProducerId: producerId,
        userId: socket.data.userId
      });
    }
    
    console.log(`Producer ${producerId} closed by socket ${socket.id}`);
  });

  socket.on('chatMessage', ({ roomId, userId, userName, message }) => {
    console.log(`Chat message from ${userName}: ${message}`);
    io.in(roomId).emit('chatMessage', { userId, userName, message, timestamp: Date.now() });
  });
  
  socket.on('userReady', ({ userId, roomId }) => {
    console.log(`User ${userId} is ready in room ${roomId}`);
    
    try {
      const room = rooms.get(roomId);
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        return;
      }
      
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
        return;
      }
      
      // Mark the peer as ready
      peer.ready = true;
      
      // Notify all other peers in the room
      socket.to(roomId).emit('userReady', {
        userId,
        userName: peer.userName
      });
      
      console.log(`User ${userId} (${peer.userName}) is ready in room ${roomId}`);
      
      // Update the socket's last activity time
      if (activeSockets.has(socket.id)) {
        const socketData = activeSockets.get(socket.id);
        socketData.lastActivity = Date.now();
        activeSockets.set(socket.id, socketData);
      }
    } catch (error) {
      console.error(`Error handling userReady for socket ${socket.id}:`, error);
    }
  });

  socket.on('leaveRoom', () => {
    console.log(`leaveRoom requested by socket ${socket.id}`);
    handleUserLeaving(socket);
  });

  // Add a function to handle ICE restart
  socket.on('restartIce', async ({ transportId }) => {
    console.log(`ICE restart requested for transport ${transportId} by socket ${socket.id}`);
    
    try {
      const { roomId } = socket.data;
      const room = rooms.get(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      const peer = room.peers.get(socket.id);
      
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
        socket.emit('error', { message: 'Peer not found' });
        return;
      }
      
      const transport = peer.transports[transportId];
      
      if (!transport) {
        console.error(`Transport ${transportId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Transport not found' });
        return;
      }
      
      // Restart ICE
      const iceParameters = await transport.restartIce();
      
      console.log(`ICE restarted for transport ${transportId}`);
      socket.emit('iceRestarted', { transportId, iceParameters });
    } catch (error) {
      console.error(`Error restarting ICE for transport ${transportId}:`, error);
      socket.emit('error', { message: 'Failed to restart ICE', error: error.message });
    }
  });

  // Add a function to check transport status
  socket.on('checkTransportStatus', ({ transportId }, callback) => {
    console.log(`Transport status check requested for ${transportId} by socket ${socket.id}`);
    
    try {
      const { roomId } = socket.data;
      const room = rooms.get(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        if (callback) callback({ error: 'Room not found' });
        return;
      }
      
      const peer = room.peers.get(socket.id);
      
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
        if (callback) callback({ error: 'Peer not found' });
        return;
      }
      
      const transport = peer.transports[transportId];
      
      if (!transport) {
        console.error(`Transport ${transportId} not found for socket ${socket.id}`);
        if (callback) callback({ error: 'Transport not found' });
        return;
      }
      
      const status = {
        id: transport.id,
        connectionState: transport.connectionState,
        iceState: transport.iceState,
        dtlsState: transport.dtlsState,
        sctpState: transport.sctpState,
        iceCandidates: transport.iceCandidates,
        iceParameters: transport.iceParameters,
        dtlsParameters: transport.dtlsParameters
      };
      
      if (callback) callback({ status });
    } catch (error) {
      console.error(`Error checking transport status:`, error);
      if (callback) callback({ error: error.message });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Workers: ${workers.length}`);
  console.log(`Announced IP: ${process.env.ANNOUNCED_IP || 'default'}`);
  console.log(`CORS: ${process.env.CORS_ORIGIN || 'all origins'}`);
  
  console.log('Available endpoints:');
  console.log('- GET /health - Health check endpoint');
  console.log('- GET / - Server info');
  console.log('- WebSocket - Socket.io connection');
});

server.on('error', (error) => {
  console.error('Server error:', error);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  cleanupAndExit();
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  cleanupAndExit();
});

function cleanupAndExit() {
  for (const roomId of rooms.keys()) {
    closeAndCleanupRoom(roomId);
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  setTimeout(() => {
    console.error('Forced exit due to timeout');
    process.exit(1);
  }, 5000);
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

io.on('error', (error) => {
  console.error('Socket.io server error:', error);
});

io.engine.on('connection_error', (err) => {
  console.error('Socket.io connection error:', err);
});

function handleUserLeaving(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  
  const room = rooms.get(roomId);
  if (!room) return;
  
  const peer = room.peers.get(socket.id);
  if (!peer) return;
  
  socket.to(roomId).emit('userLeft', { userId: socket.data.userId });
  
  for (const key in peer.transports) {
    try {
      console.log(`Closing transport ${key} for socket ${socket.id}`);
      peer.transports[key].close();
    } catch (e) {
      console.error(`Error closing transport ${key} for socket ${socket.id}:`, e);
    }
  }
  
  peer.producers.forEach(producer => {
    try {
      console.log(`Closing producer ${producer.id} for socket ${socket.id}`);
      producer.close();
    } catch (e) {
      console.error(`Error closing producer ${producer.id} for socket ${socket.id}:`, e);
    }
    
    socket.to(roomId).emit('producerClosed', {
      remoteProducerId: producer.id,
      userId: socket.data.userId
    });
  });
  
  peer.consumers.forEach(consumer => {
    try {
      console.log(`Closing consumer ${consumer.id} for socket ${socket.id}`);
      consumer.close();
    } catch (e) {
      console.error(`Error closing consumer ${consumer.id} for socket ${socket.id}:`, e);
    }
  });
  
  room.peers.delete(socket.id);
  socket.leave(roomId);
  console.log(`User ${socket.data.userId} left room ${roomId}`);
  
  if (room.peers.size === 0) {
    console.log(`Room ${roomId} is empty. Closing router and cleaning up room.`);
    closeAndCleanupRoom(roomId);
  }
}

function findUserIdForProducer(producerId, room) {
  for (const [socketId, peer] of room.peers.entries()) {
    for (const [id, producer] of peer.producers.entries()) {
      if (id === producerId) {
        return peer.userId;
      }
    }
  }
  return null;
}

// Add a heartbeat mechanism to keep connections alive
setInterval(() => {
  const now = Date.now();
  
  // Check for stale connections
  for (const [socketId, socketData] of activeSockets.entries()) {
    const lastActivity = socketData.lastActivity || 0;
    const inactiveTime = now - lastActivity;
    
    // If inactive for more than 2 minutes, check if it's still alive
    if (inactiveTime > 2 * 60 * 1000) {
      const socket = socketData.socket;
      
      // Ping the socket to see if it's still alive
      socket.emit('ping', () => {
        // If we get a response, update the last activity time
        socketData.lastActivity = Date.now();
        activeSockets.set(socketId, socketData);
      });
      
      // If inactive for more than 5 minutes, consider it dead and clean up
      if (inactiveTime > 5 * 60 * 1000) {
        console.log(`Socket ${socketId} inactive for more than 5 minutes, cleaning up`);
        handleUserLeaving(socket);
        activeSockets.delete(socketId);
      }
    }
  }
}, 60000); // Check every minute