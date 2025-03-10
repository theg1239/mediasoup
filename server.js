const express = require('express')
const http = require('http')
const cors = require('cors')
const socketIo = require('socket.io')
const mediasoup = require('mediasoup')

const app = express()
app.use(cors({ origin: ['http://localhost:3000', process.env.FRONTEND_URL || ''] }))
const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:3000', process.env.FRONTEND_URL || ''],
    methods: ['GET', 'POST']
  }
})

const mediasoupOptions = {
  worker: {
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
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
}

let worker
;(async () => {
  try {
    worker = await mediasoup.createWorker(mediasoupOptions.worker)
    worker.on('died', () => {
      setTimeout(() => process.exit(1), 2000)
    })
    console.log('Mediasoup Worker created')
  } catch (err) {
    console.error('Failed to create mediasoup worker', err)
  }
})()

const rooms = new Map()

async function createRoom(roomId) {
  try {
    const router = await worker.createRouter({ mediaCodecs: mediasoupOptions.router.mediaCodecs })
    const room = {
      id: roomId,
      router,
      peers: new Map()
    }
    rooms.set(roomId, room)
    console.log(`Room ${roomId} created`)
    return room
  } catch (error) {
    console.error('Error creating room', error)
  }
}

async function createWebRtcTransport(router) {
  try {
    const transport = await router.createWebRtcTransport(mediasoupOptions.webRtcTransport)
    return transport
  } catch (error) {
    console.error('Error creating WebRTC transport', error)
    throw error
  }
}

io.on('connection', socket => {
  console.log('Socket connected:', socket.id)
  socket.data = {}

  socket.on('joinRoom', async ({ roomId, userId }) => {
    socket.data.roomId = roomId
    socket.data.userId = userId
    let room = rooms.get(roomId)
    if (!room) {
      room = await createRoom(roomId)
    }
    room.peers.set(socket.id, {
      socket,
      transports: {},
      producers: new Map(),
      consumers: new Map()
    })
    socket.join(roomId)
    console.log(`User ${userId} joined room ${roomId}`)
  })

  socket.on('getRouterRtpCapabilities', () => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    socket.emit('routerRtpCapabilities', room.router.rtpCapabilities)
  })

  socket.on('createProducerTransport', async ({ forceTcp, rtpCapabilities }) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    try {
      const transport = await createWebRtcTransport(room.router)
      const peer = room.peers.get(socket.id)
      peer.transports.producer = transport
      const params = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
      }
      socket.emit('producerTransportCreated', params)
    } catch (error) {
      console.error('createProducerTransport error:', error)
    }
  })

  socket.on('connectProducerTransport', async ({ dtlsParameters }) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer || !peer.transports.producer) return
    try {
      await peer.transports.producer.connect({ dtlsParameters })
      console.log('Producer transport connected for', socket.id)
    } catch (error) {
      console.error('Error connecting producer transport:', error)
    }
  })

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer || !peer.transports.producer) return
    try {
      const producer = await peer.transports.producer.produce({ kind, rtpParameters })
      peer.producers.set(producer.id, producer)
      console.log(`Producer ${producer.id} created for ${socket.data.userId}`)
      socket.to(roomId).emit('newProducer', { remoteProducerId: producer.id, userId: socket.data.userId })
      callback(producer.id)
    } catch (error) {
      console.error('Produce error:', error)
      callback({ error: error.message })
    }
  })

  socket.on('createConsumerTransport', async ({ forceTcp, remoteProducerId }) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer) return
    try {
      const transport = await createWebRtcTransport(room.router)
      peer.transports[remoteProducerId] = transport
      const params = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
      }
      socket.emit('consumerTransportCreated', { ...params, remoteProducerId })
    } catch (error) {
      console.error('createConsumerTransport error:', error)
    }
  })

  socket.on('connectConsumerTransport', async ({ transportId, dtlsParameters }) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer) return
    const transport = Object.values(peer.transports).find(t => t.id === transportId)
    if (!transport) return
    try {
      await transport.connect({ dtlsParameters })
      console.log('Consumer transport connected for', socket.id)
    } catch (error) {
      console.error('Error connecting consumer transport:', error)
    }
  })

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer) return
    try {
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: 'Cannot consume' })
      }
      const consumerTransport = Object.values(peer.transports).find(t => t.id === transportId)
      if (!consumerTransport) return
      const consumer = await consumerTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      })
      peer.consumers.set(consumer.id, consumer)
      consumer.on('transportclose', () => {
        peer.consumers.delete(consumer.id)
      })
      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        userId: socket.data.userId
      })
      setTimeout(() => {
        consumer.resume()
        socket.emit('resumeConsumer', { consumerId: consumer.id })
      }, 500)
    } catch (error) {
      console.error('Consume error:', error)
      callback({ error: error.message })
    }
  })

  socket.on('resumeConsumer', async ({ consumerId }) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer) return
    const consumer = peer.consumers.get(consumerId)
    if (!consumer) return
    try {
      await consumer.resume()
    } catch (error) {
      console.error('Error resuming consumer:', error)
    }
  })

  socket.on('leaveRoom', () => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer) return
    for (const key in peer.transports) {
      try {
        peer.transports[key].close()
      } catch (e) {
        console.error(e)
      }
    }
    peer.producers.forEach(producer => {
      try {
        producer.close()
      } catch (e) {}
      socket.to(roomId).emit('producerClosed', producer.id)
    })
    peer.consumers.forEach(consumer => {
      try {
        consumer.close()
      } catch (e) {}
    })
    room.peers.delete(socket.id)
    socket.leave(roomId)
    console.log(`User ${socket.data.userId} left room ${roomId}`)
    if (room.peers.size === 0) {
      room.router.close()
      rooms.delete(roomId)
      console.log(`Room ${roomId} closed as empty`)
    }
  })

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id)
    const roomId = socket.data.roomId
    if (!roomId) return
    const room = rooms.get(roomId)
    if (!room) return
    const peer = room.peers.get(socket.id)
    if (!peer) return
    for (const key in peer.transports) {
      try {
        peer.transports[key].close()
      } catch (e) {}
    }
    peer.producers.forEach(producer => {
      try {
        producer.close()
      } catch (e) {}
      socket.to(roomId).emit('producerClosed', producer.id)
    })
    peer.consumers.forEach(consumer => {
      try {
        consumer.close()
      } catch (e) {}
    })
    room.peers.delete(socket.id)
    socket.leave(roomId)
    console.log(`Cleaned up user ${socket.data.userId} on disconnect`)
    if (room.peers.size === 0) {
      room.router.close()
      rooms.delete(roomId)
      console.log(`Room ${roomId} closed as empty`)
    }
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})
