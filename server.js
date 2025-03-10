const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os');

const app = express();
app.use(cors({ origin: ['http://localhost:3000', process.env.FRONTEND_URL || ''] }));

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:3000', process.env.FRONTEND_URL || ''],
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000, // Longer ping timeout
  pingInterval: 25000 // More frequent pings
}); 

function getListenIps() {
  const interfaces = os.networkInterfaces();
  const listenIps = [];
  
  let publicIp = process.env.ANNOUNCED_IP;
  
  if (!publicIp && process.env.DYNO) {
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
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
    logLevel: 'warn',
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
        parameters: { 'x-google-start-bitrate': 1000 }
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: { 'x-google-start-bitrate': 1000 }
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000
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
    maxSctpMessageSize: 262144
  }
};

const roomsInCreation = new Map();

let workers = [];
const workerLoadCount = new Map();

async function createWorkers() {
  const { numWorkers = 1 } = process.env;
  const coreCount = os.cpus().length;
  const count = Math.min(Number(numWorkers), coreCount);
  
  console.log(`Creating ${count} mediasoup workers...`);
  
  for (let i = 0; i < count; i++) {
    const worker = await mediasoup.createWorker(mediasoupOptions.worker);
    worker.on('died', () => {
      console.error(`Mediasoup Worker ${i} died, exiting in 2 seconds...`);
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(worker);
    workerLoadCount.set(worker, 0);
    console.log(`Mediasoup Worker ${i} created`);
  }
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
      roomsInCreation.delete(roomId);
    }
  });
  
  roomsInCreation.set(roomId, creationPromise);
  
  return creationPromise;
}

async function createWebRtcTransport(router) {
  try {
    console.log('Creating WebRTC transport...');
    const transport = await router.createWebRtcTransport(mediasoupOptions.webRtcTransport);
    
    transport.isConnecting = false;
    
    try {
      await transport.setMaxIncomingBitrate(1500000);
    } catch (error) {
      console.log('Error setting max incoming bitrate:', error);
    }
    
    console.log('WebRTC transport created:', transport.id);
    return transport;
  } catch (error) {
    console.error('Error creating WebRTC transport:', error);
    throw error;
  }
}

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

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);
  socket.data = {};

  socket.on('ping', (callback) => {
    callback();
  });

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

  socket.on('createProducerTransport', async ({ forceTcp, rtpCapabilities }) => {
    console.log(`createProducerTransport requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    
    try {
      const room = await getOrCreateRoom(roomId);
      
      if (!room) {
        console.error(`Room ${roomId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      const transport = await createWebRtcTransport(room.router);
      const peer = room.peers.get(socket.id);
      
      if (!peer) {
        console.error(`Peer not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Peer not found' });
        return;
      }
      
      peer.transports.producer = transport;
      
      const params = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
      };
      
      socket.emit('producerTransportCreated', params);
      console.log(`Producer transport created for user ${socket.data.userId} on socket ${socket.id}`);
    } catch (error) {
      console.error('createProducerTransport error:', error);
      socket.emit('error', { message: 'Failed to create producer transport', error: error.message });
    }
  });

  socket.on('connectProducerTransport', async ({ dtlsParameters }) => {
    console.log(`connectProducerTransport requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const peer = room.peers.get(socket.id);
    if (!peer || !peer.transports.producer) {
      console.error(`Producer transport not found for socket ${socket.id}`);
      socket.emit('error', { message: 'Producer transport not found' });
      return;
    }
    
    try {
      if (peer.transports.producer.isConnecting || 
          (peer.transports.producer.connectionState && peer.transports.producer.connectionState !== 'new')) {
        console.log(`Producer transport already connecting/connected for socket ${socket.id}`);
        socket.emit('producerTransportConnected');
        return;
      }
      
      peer.transports.producer.isConnecting = true;
      await peer.transports.producer.connect({ dtlsParameters });
      console.log('Producer transport connected for socket', socket.id);
      peer.transports.producer.isConnecting = false;
      socket.emit('producerTransportConnected');
    } catch (error) {
      console.error('Error connecting producer transport for socket', socket.id, error);
      peer.transports.producer.isConnecting = false;
      socket.emit('error', { message: 'Failed to connect producer transport', error: error.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    console.log(`produce event received from socket ${socket.id} for kind ${kind}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      callback({ error: 'Room not found' });
      return;
    }
    
    const peer = room.peers.get(socket.id);
    if (!peer || !peer.transports.producer) {
      console.error(`Producer transport not found for socket ${socket.id}`);
      callback({ error: 'Producer transport not found' });
      return;
    }
    
    try {
      const isScreenShare = appData && appData.trackType === 'screen';
      let existingProducer = null;
      
      for (const [prodId, prod] of peer.producers.entries()) {
        const prodIsScreen = prod.appData && prod.appData.trackType === 'screen';
        if (prod.kind === kind && 
            ((isScreenShare && prodIsScreen) || (!isScreenShare && !prodIsScreen))) {
          existingProducer = prod;
          break;
        }
      }
      
      if (existingProducer) {
        console.log(`Closing existing producer ${existingProducer.id} of kind ${kind} for socket ${socket.id}`);
        existingProducer.close();
        peer.producers.delete(existingProducer.id);
        socket.to(roomId).emit('producerClosed', {
          remoteProducerId: existingProducer.id,
          userId: socket.data.userId
        });
      }
      
      const producer = await peer.transports.producer.produce({ 
        kind, 
        rtpParameters,
        appData: appData || { userId: socket.data.userId }
      });
      
      peer.producers.set(producer.id, producer);
      console.log(`Producer ${producer.id} (${kind}) created for user ${socket.data.userId} on socket ${socket.id}`);
      
      socket.to(roomId).emit('newProducer', {
        remoteProducerId: producer.id,
        kind,
        userId: socket.data.userId,
        userName: socket.data.userName,
        userInitials: socket.data.userEmail?.substring(0, 2) || socket.data.userName.substring(0, 2),
        appData
      });
      
      callback(producer.id);
      
      producer.on('transportclose', () => {
        console.log(`Transport closed for producer ${producer.id} on socket ${socket.id}`);
        producer.close();
        peer.producers.delete(producer.id);
      });
      
      producer.on('close', () => {
        console.log(`Producer ${producer.id} closed on socket ${socket.id}`);
        peer.producers.delete(producer.id);
      });
      
    } catch (error) {
      console.error('Produce error for socket', socket.id, error);
      callback({ error: error.message });
    }
  });

  socket.on('trickleCandidate', async ({ transportId, candidate }) => {
    console.log(`Trickle ICE candidate received on socket ${socket.id} for transport ${transportId}`);
    const peer = getPeerForSocket(socket);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id} in trickleCandidate`);
      return;
    }
    
    let transport = null;
    if (peer.transports.producer && peer.transports.producer.id === transportId) {
      transport = peer.transports.producer;
    } else {
      for (const [_, t] of Object.entries(peer.transports)) {
        if (t.id === transportId) {
          transport = t;
          break;
        }
      }
    }
    
    if (!transport) {
      console.error(`Transport ${transportId} not found for trickle candidate on socket ${socket.id}`);
      return;
    }
    
    try {
      await transport.addIceCandidate(candidate);
      console.log(`Added ICE candidate to transport ${transportId} on socket ${socket.id}`);
    } catch (error) {
      console.error(`Error adding ICE candidate on transport ${transportId}:`, error);
    }
  });

  socket.on('createConsumerTransport', async ({ forceTcp, remoteProducerId }) => {
    console.log(`createConsumerTransport requested by socket ${socket.id} for remoteProducer ${remoteProducerId}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const peer = room.peers.get(socket.id);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id}`);
      socket.emit('error', { message: 'Peer not found' });
      return;
    }
    
    try {
      if (peer.transports[remoteProducerId]) {
        console.log(`Consumer transport already exists for remoteProducer ${remoteProducerId} on socket ${socket.id}`);
        const existingTransport = peer.transports[remoteProducerId];
        
        const params = {
          id: existingTransport.id,
          iceParameters: existingTransport.iceParameters,
          iceCandidates: existingTransport.iceCandidates,
          dtlsParameters: existingTransport.dtlsParameters,
          sctpParameters: existingTransport.sctpParameters
        };
        
        socket.emit('consumerTransportCreated', { ...params, remoteProducerId, userId: peer.userId });
        return;
      }
      
      const transport = await createWebRtcTransport(room.router);
      peer.transports[remoteProducerId] = transport;
      
      const params = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
      };
      
      socket.emit('consumerTransportCreated', { ...params, remoteProducerId, userId: peer.userId });
      console.log(`Consumer transport created for socket ${socket.id} for remoteProducer ${remoteProducerId}`);
    } catch (error) {
      console.error('createConsumerTransport error for socket', socket.id, error);
      socket.emit('error', { message: 'Failed to create consumer transport', error: error.message });
    }
  });

  socket.on('connectConsumerTransport', async ({ transportId, dtlsParameters }) => {
    console.log(`connectConsumerTransport requested by socket ${socket.id} for transport ${transportId}`);
    const peer = getPeerForSocket(socket);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id} in connectConsumerTransport`);
      socket.emit('error', { message: 'Peer not found' });
      return;
    }
    
    let transport = null;
    for (const [_, t] of Object.entries(peer.transports)) {
      if (t.id === transportId) {
        transport = t;
        break;
      }
    }
    
    if (!transport) {
      console.error(`Transport ${transportId} not found for socket ${socket.id}`);
      socket.emit('error', { message: 'Transport not found' });
      return;
    }
    
    try {
      if (transport.isConnecting || (transport.connectionState && transport.connectionState !== 'new')) {
         console.log(`Consumer transport already connecting/connected for socket ${socket.id}`);
         socket.emit('consumerTransportConnected', { transportId });
         return;
      }
      
      transport.isConnecting = true;
      await transport.connect({ dtlsParameters });
      transport.isConnecting = false;
      console.log('Consumer transport connected for socket', socket.id);
      socket.emit('consumerTransportConnected', { transportId });
    } catch (error) {
      console.error('Error connecting consumer transport for socket', socket.id, error);
      transport.isConnecting = false;
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
  
  socket.on('userReady', ({ userId, userName, userInitials }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    
    console.log(`User ${userId} (${userName}) is ready in room ${roomId}`);
    
    // Note: This could be used to trigger specific actions when all users are ready
  });

  socket.on('leaveRoom', () => {
    console.log(`leaveRoom requested by socket ${socket.id}`);
    handleUserLeaving(socket);
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    handleUserLeaving(socket);
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
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});