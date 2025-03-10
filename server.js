const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
app.use(cors({ origin: ['http://localhost:3000', process.env.FRONTEND_URL || ''] }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:3000', process.env.FRONTEND_URL || ''],
    methods: ['GET', 'POST']
  }
});

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
      }
    ]
  },
  webRtcTransport: {
    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || null }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000
  }
};

let worker;
(async () => {
  try {
    console.log('Creating mediasoup worker...');
    worker = await mediasoup.createWorker(mediasoupOptions.worker);
    worker.on('died', () => {
      console.error('Mediasoup Worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });
    console.log('Mediasoup Worker created');
  } catch (err) {
    console.error('Failed to create mediasoup worker:', err);
  }
})();

const rooms = new Map();

async function createRoom(roomId) {
  try {
    console.log(`Attempting to create room ${roomId}`);
    const router = await worker.createRouter({
      mediaCodecs: mediasoupOptions.router.mediaCodecs
    });
    const room = { id: roomId, router, peers: new Map() };
    rooms.set(roomId, room);
    console.log(`Room ${roomId} created successfully`);
    return room;
  } catch (error) {
    console.error('Error creating room:', error);
  }
}

async function createWebRtcTransport(router) {
  try {
    console.log('Creating WebRTC transport...');
    const transport = await router.createWebRtcTransport(mediasoupOptions.webRtcTransport);
    // Initialize a flag to prevent duplicate connect calls.
    transport.isConnecting = false;
    console.log('WebRTC transport created:', transport.id);
    return transport;
  } catch (error) {
    console.error('Error creating WebRTC transport:', error);
    throw error;
  }
}

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);
  socket.data = {};

  socket.on('joinRoom', async ({ roomId, userId, userName, userEmail }) => {
    console.log(`joinRoom event received from socket ${socket.id} for room ${roomId}`);
    socket.data.roomId = roomId;
    socket.data.userId = userId;
    socket.data.userName = userName;
    socket.data.userEmail = userEmail;
    let room = rooms.get(roomId);
    if (!room) {
      room = await createRoom(roomId);
    }
    room.peers.set(socket.id, {
      socket,
      transports: {},
      producers: new Map(),
      consumers: new Map(),
      userName,
      userEmail
    });
    socket.join(roomId);
    console.log(`User ${userId} (${userName}, ${userEmail}) joined room ${roomId}`);
    // Notify other peers that a new user has joined.
    socket.to(roomId).emit('userJoined', {
      userId,
      userName,
      userInitials: userName.substring(0, 2)
    });
  });

  socket.on('getRouterRtpCapabilities', () => {
    console.log(`getRouterRtpCapabilities requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`No room found for socket ${socket.id}`);
      return;
    }
    socket.emit('routerRtpCapabilities', room.router.rtpCapabilities);
    console.log(`Sent router RTP capabilities to socket ${socket.id}`);
  });

  socket.on('createProducerTransport', async ({ forceTcp, rtpCapabilities }) => {
    console.log(`createProducerTransport requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      return;
    }
    try {
      const transport = await createWebRtcTransport(room.router);
      const peer = room.peers.get(socket.id);
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
    }
  });

  socket.on('connectProducerTransport', async ({ dtlsParameters }) => {
    console.log(`connectProducerTransport requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      return;
    }
    const peer = room.peers.get(socket.id);
    if (!peer || !peer.transports.producer) {
      console.error(`Producer transport not found for socket ${socket.id}`);
      return;
    }
    try {
      if (peer.transports.producer.isConnecting || 
          (peer.transports.producer.connectionState && peer.transports.producer.connectionState !== 'new')) {
        console.log(`Producer transport already connecting/connected for socket ${socket.id}`);
        return;
      }
      peer.transports.producer.isConnecting = true;
      await peer.transports.producer.connect({ dtlsParameters });
      console.log('Producer transport connected for socket', socket.id);
      peer.transports.producer.isConnecting = false;
    } catch (error) {
      console.error('Error connecting producer transport for socket', socket.id, error);
      peer.transports.producer.isConnecting = false;
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    console.log(`produce event received from socket ${socket.id} for kind ${kind}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      return;
    }
    const peer = room.peers.get(socket.id);
    if (!peer || !peer.transports.producer) {
      console.error(`Producer transport not found for socket ${socket.id}`);
      return;
    }
    try {
      // Close any existing producer of the same kind.
      for (const [prodId, prod] of peer.producers.entries()) {
        if (prod.kind === kind) {
          console.log(`Closing existing producer ${prodId} of kind ${kind} for socket ${socket.id}`);
          prod.close();
          peer.producers.delete(prodId);
          socket.to(roomId).emit('producerClosed', prodId);
          break;
        }
      }
      const producer = await peer.transports.producer.produce({ kind, rtpParameters });
      peer.producers.set(producer.id, producer);
      console.log(`Producer ${producer.id} (${kind}) created for user ${socket.data.userId} on socket ${socket.id}`);
      socket.to(roomId).emit('newProducer', {
        remoteProducerId: producer.id,
        kind,
        userId: socket.data.userId,
        userName: socket.data.userName,
        userEmail: socket.data.userEmail
      });
      callback(producer.id);
    } catch (error) {
      console.error('Produce error for socket', socket.id, error);
      callback({ error: error.message });
    }
  });

  // Handle trickle ICE candidates from the client.
  socket.on('trickleCandidate', async ({ transportId, candidate }) => {
    console.log(`Trickle ICE candidate received on socket ${socket.id} for transport ${transportId}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    if (!peer) return;
    // Find the transport by id among all transports
    const allTransports = Object.values(peer.transports);
    const transport = allTransports.find(t => t.id === transportId);
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
      return;
    }
    const peer = room.peers.get(socket.id);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id}`);
      return;
    }
    try {
      if (peer.transports[remoteProducerId]) {
        console.log(`Consumer transport already exists for remoteProducer ${remoteProducerId} on socket ${socket.id}`);
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
      socket.emit('consumerTransportCreated', { ...params, remoteProducerId });
      console.log(`Consumer transport created for socket ${socket.id} for remoteProducer ${remoteProducerId}`);
    } catch (error) {
      console.error('createConsumerTransport error for socket', socket.id, error);
    }
  });

  socket.on('connectConsumerTransport', async ({ transportId, dtlsParameters }) => {
    console.log(`connectConsumerTransport requested by socket ${socket.id} for transport ${transportId}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      return;
    }
    const peer = room.peers.get(socket.id);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id}`);
      return;
    }
    const transport = Object.values(peer.transports).find(t => t.id === transportId);
    if (!transport) {
      console.error(`Transport ${transportId} not found for socket ${socket.id}`);
      return;
    }
    try {
      if (transport.isConnecting || (transport.connectionState && transport.connectionState !== 'new')) {
         console.log(`Consumer transport already connecting/connected for socket ${socket.id}`);
         return;
      }
      transport.isConnecting = true;
      await transport.connect({ dtlsParameters });
      transport.isConnecting = false;
      console.log('Consumer transport connected for socket', socket.id);
    } catch (error) {
      console.error('Error connecting consumer transport for socket', socket.id, error);
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    console.log(`consume event received from socket ${socket.id} for producer ${producerId}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found for socket ${socket.id}`);
      return;
    }
    const peer = room.peers.get(socket.id);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id}`);
      return;
    }
    try {
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        console.error(`Cannot consume for socket ${socket.id}, invalid RTP capabilities`);
        return callback({ error: 'Cannot consume' });
      }
      const consumerTransport = Object.values(peer.transports).find(t => t.id === transportId);
      if (!consumerTransport) {
        console.error(`Consumer transport ${transportId} not found for socket ${socket.id}`);
        return;
      }
      const consumer = await consumerTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      });
      peer.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => {
        console.log(`Transport closed for consumer ${consumer.id} on socket ${socket.id}`);
        peer.consumers.delete(consumer.id);
      });
      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        peerId: socket.data.userId
      });
      try {
        await consumer.resume();
        console.log(`Consumer ${consumer.id} resumed for socket ${socket.id}`);
      } catch (err) {
        console.error(`Error resuming consumer ${consumer.id} for socket ${socket.id}:`, err);
      }
      console.log(`Consumer ${consumer.id} created for socket ${socket.id}`);
    } catch (error) {
      console.error('Consume error for socket', socket.id, error);
      callback({ error: error.message });
    }
  });

  // Chat support: relay chat messages to all clients in the room.
  socket.on('chatMessage', ({ roomId, userId, userName, message }) => {
    console.log(`Chat message from ${userName}: ${message}`);
    io.in(roomId).emit('chatMessage', { userId, userName, message, timestamp: Date.now() });
  });

  socket.on('leaveRoom', () => {
    console.log(`leaveRoom requested by socket ${socket.id}`);
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found when socket ${socket.id} tried to leave`);
      return;
    }
    const peer = room.peers.get(socket.id);
    if (!peer) {
      console.error(`Peer not found for socket ${socket.id} in room ${roomId}`);
      return;
    }
    // Notify others that this user is leaving.
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
      socket.to(roomId).emit('producerClosed', producer.id);
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
      room.router.close();
      rooms.delete(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    if (!peer) return;
    // Notify remaining peers that this user has left.
    socket.to(roomId).emit('userLeft', { userId: socket.data.userId });
    for (const key in peer.transports) {
      try {
        console.log(`Closing transport ${key} for disconnected socket ${socket.id}`);
        peer.transports[key].close();
      } catch (e) {
        console.error(`Error closing transport ${key} for socket ${socket.id}:`, e);
      }
    }
    peer.producers.forEach(producer => {
      try {
        console.log(`Closing producer ${producer.id} for disconnected socket ${socket.id}`);
        producer.close();
      } catch (e) {
        console.error(`Error closing producer ${producer.id} for socket ${socket.id}:`, e);
      }
      socket.to(roomId).emit('producerClosed', producer.id);
    });
    peer.consumers.forEach(consumer => {
      try {
        console.log(`Closing consumer ${consumer.id} for disconnected socket ${socket.id}`);
        consumer.close();
      } catch (e) {
        console.error(`Error closing consumer ${consumer.id} for socket ${socket.id}:`, e);
      }
    });
    room.peers.delete(socket.id);
    socket.leave(roomId);
    console.log(`Cleaned up user ${socket.data.userId} on disconnect`);
    if (room.peers.size === 0) {
      console.log(`Room ${roomId} is empty after disconnect. Closing router and deleting room.`);
      room.router.close();
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
