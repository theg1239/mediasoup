const { io } = require('socket.io-client');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const cluster = require('cluster');
const numCPUs = os.cpus().length;

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const ROOM_COUNT = 15;
const USERS_PER_ROOM = 20;
const TOTAL_CONNECTIONS = ROOM_COUNT * USERS_PER_ROOM;
const CONNECTION_DELAY_MS = 50;
const TEST_DURATION_MS = 5 * 60 * 1000;
const STATS_INTERVAL_MS = 5000;

let connectedCount = 0;
let disconnectedCount = 0;
let failedCount = 0;
let messagesSent = 0;
let messagesReceived = 0;
let roomsCreated = 0;
let startTime = null;
let connections = [];
let rooms = [];

for (let i = 0; i < ROOM_COUNT; i++) {
  rooms.push(`test-room-${i}-${uuidv4().substring(0, 8)}`);
}

const latencies = [];
const cpuUsage = [];
const memoryUsage = [];

if (cluster.isPrimary) {
  console.log(`Primary process ${process.pid} is running`);
  console.log(`Testing server at: ${SERVER_URL}`);
  console.log(`Simulating ${ROOM_COUNT} rooms with ${USERS_PER_ROOM} users each (${TOTAL_CONNECTIONS} total connections)`);
  console.log(`Test will run for ${TEST_DURATION_MS / 60000} minutes`);
  
  const connectionsPerWorker = Math.ceil(TOTAL_CONNECTIONS / numCPUs);
  
  for (let i = 0; i < numCPUs; i++) {
    const worker = cluster.fork();
    
    const startIdx = i * connectionsPerWorker;
    const endIdx = Math.min(startIdx + connectionsPerWorker, TOTAL_CONNECTIONS);
    
    worker.send({ 
      type: 'INIT', 
      startIdx, 
      endIdx,
      rooms
    });
  }
  
  let totalConnected = 0;
  let totalDisconnected = 0;
  let totalFailed = 0;
  let totalMessagesSent = 0;
  let totalMessagesReceived = 0;
  
  Object.values(cluster.workers).forEach(worker => {
    worker.on('message', (msg) => {
      if (msg.type === 'STATS') {
        totalConnected += msg.connected;
        totalDisconnected += msg.disconnected;
        totalFailed += msg.failed;
        totalMessagesSent += msg.messagesSent;
        totalMessagesReceived += msg.messagesReceived;
        
        if (Object.keys(cluster.workers).length === Object.values(cluster.workers).filter(w => w.stats).length) {
          logStats(totalConnected, totalDisconnected, totalFailed, totalMessagesSent, totalMessagesReceived);
          
          totalConnected = 0;
          totalDisconnected = 0;
          totalFailed = 0;
          totalMessagesSent = 0;
          totalMessagesReceived = 0;
          Object.values(cluster.workers).forEach(w => w.stats = false);
        }
      }
    });
  });
  
  setTimeout(() => {
    console.log('\n--- Test Complete ---');
    Object.values(cluster.workers).forEach(worker => {
      worker.send({ type: 'SHUTDOWN' });
    });
    
    setTimeout(() => {
      console.log('Shutting down primary process');
      process.exit(0);
    }, 5000);
  }, TEST_DURATION_MS);
  
} else {
  console.log(`Worker ${process.pid} started`);
  let startIdx, endIdx, workerRooms;
  let connections = [];
  
  process.on('message', async (msg) => {
    if (msg.type === 'INIT') {
      startIdx = msg.startIdx;
      endIdx = msg.endIdx;
      workerRooms = msg.rooms;
      
      console.log(`Worker ${process.pid} handling connections ${startIdx} to ${endIdx-1}`);
      
      startConnections();
      
      setInterval(() => {
        process.send({ 
          type: 'STATS', 
          connected: connectedCount,
          disconnected: disconnectedCount,
          failed: failedCount,
          messagesSent,
          messagesReceived
        });
        worker.stats = true;
        
        connectedCount = 0;
        disconnectedCount = 0;
        failedCount = 0;
        messagesSent = 0;
        messagesReceived = 0;
      }, STATS_INTERVAL_MS);
      
    } else if (msg.type === 'SHUTDOWN') {
      console.log(`Worker ${process.pid} shutting down, closing ${connections.length} connections`);
      connections.forEach(conn => {
        if (conn && conn.connected) {
          conn.disconnect();
        }
      });
      
      setTimeout(() => {
        process.exit(0);
      }, 2000);
    }
  });
}

async function startConnections() {
  startTime = Date.now();
  
  for (let i = startIdx; i < endIdx; i++) {
    const roomIndex = Math.floor(i / USERS_PER_ROOM);
    const roomId = workerRooms[roomIndex];
    const userId = `user-${i}-${uuidv4().substring(0, 8)}`;
    const userName = `Test User ${i}`;
    
    setTimeout(() => {
      createConnection(roomId, userId, userName, i);
    }, i * CONNECTION_DELAY_MS);
  }
}

function createConnection(roomId, userId, userName, index) {
  try {
    const socket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000
    });
    
    connections[index] = socket;
    
    // Connection events
    socket.on('connect', () => {
      connectedCount++;
      
      // Join room
      socket.emit('joinRoom', {
        roomName: roomId,
        userId: userId,
        userName: userName,
        userEmail: `${userId}@test.com`
      }, (response) => {
        if (response && response.rtpCapabilities) {
          // Successfully joined room
          socket.emit('deviceReady');
          
          // Simulate some activity
          simulateActivity(socket, roomId, userId);
        }
      });
    });
    
    socket.on('disconnect', () => {
      disconnectedCount++;
    });
    
    socket.on('connect_error', (err) => {
      failedCount++;
      console.error(`Connection error for user ${userId}: ${err.message}`);
    });
    
    socket.on('chatMessage', () => {
      messagesReceived++;
    });
    
    socket.on('userJoined', () => {
      // Another user joined
    });
    
    socket.on('userLeft', () => {
      // Another user left
    });
    
    socket.on('new-producer', () => {
      // New producer available
    });
    
    socket.on('producer-closed', () => {
      // Producer closed
    });
    
  } catch (error) {
    failedCount++;
    console.error(`Failed to create connection for user ${userId}: ${error.message}`);
  }
}

function simulateActivity(socket, roomId, userId) {
  const chatInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('chatMessage', {
        roomName: roomId,
        userId: userId,
        message: `Test message from ${userId} at ${new Date().toISOString()}`
      });
      messagesSent++;
    } else {
      clearInterval(chatInterval);
    }
  }, 30000 + Math.random() * 60000);
  
  // Toggle media state periodically
  const mediaInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('mediaStateChanged', {
        userId,
        audioEnabled: Math.random() > 0.5,
        videoEnabled: Math.random() > 0.5
      });
    } else {
      clearInterval(mediaInterval);
    }
  }, 45000 + Math.random() * 90000);
}

function logStats(connected, disconnected, failed, sent, received) {
  const elapsedSeconds = (Date.now() - startTime) / 1000;
  const memUsage = process.memoryUsage();
  
  console.log('\n--- Load Test Stats ---');
  console.log(`Time elapsed: ${Math.floor(elapsedSeconds / 60)}m ${Math.floor(elapsedSeconds % 60)}s`);
  console.log(`Connected: ${connected} | Disconnected: ${disconnected} | Failed: ${failed}`);
  console.log(`Messages sent: ${sent} | Messages received: ${received}`);
  console.log(`Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB Heap`);
  
  const successRate = (connected / (connected + failed)) * 100;
  console.log(`Connection success rate: ${successRate.toFixed(2)}%`);
  
  const deliveryRate = received > 0 ? (received / sent) * 100 : 0;
  console.log(`Message delivery rate: ${deliveryRate.toFixed(2)}%`);
} 