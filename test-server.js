"use strict";

const { io } = require('socket.io-client');

const config = {
  serverUrl: process.env.SERVER_URL || 'https://mediasoup-58e3bb17cad3.herokuapp.com',
  timeout: 10000 // 10 seconds
};

console.log(`🔍 Testing server at ${config.serverUrl}...`);

async function testHealthEndpoint() {
  console.log('\n📡 Testing HTTP health endpoint...');
  
  try {
    const response = await fetchFn(`${config.serverUrl}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ Health endpoint is working!');
      console.log(`   Server uptime: ${Math.floor(data.uptime / 60)} minutes`);
      return true;
    } else {
      console.error(`❌ Health endpoint returned status ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to connect to health endpoint: ${error.message}`);
    return false;
  }
}

function testWebSocketConnection() {
  return new Promise((resolve) => {
    console.log('\n📡 Testing WebSocket connection...');
    
    const socket = io(config.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 3,
      timeout: config.timeout
    });
    
    const timeout = setTimeout(() => {
      console.error('❌ WebSocket connection timed out');
      socket.disconnect();
      resolve(false);
    }, config.timeout);
    
    socket.on('connect', () => {
      console.log(`✅ WebSocket connected successfully with ID: ${socket.id}`);
      clearTimeout(timeout);
      
      console.log('   Testing ping...');
      socket.emit('ping', () => {
        console.log('✅ Ping received response');
        socket.disconnect();
        resolve(true);
      });
      
      setTimeout(() => {
        if (socket.connected) {
          console.error('❌ Ping timed out');
          socket.disconnect();
          resolve(false);
        }
      }, 5000);
    });
    
    socket.on('connect_error', (error) => {
      console.error(`❌ WebSocket connection error: ${error.message}`);
      clearTimeout(timeout);
      socket.disconnect();
      resolve(false);
    });
  });
}

function testRoomCreation() {
  return new Promise((resolve) => {
    console.log('\n📡 Testing room creation...');
    
    const socket = io(config.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 3,
      timeout: config.timeout
    });
    
    const timeout = setTimeout(() => {
      console.error('❌ Room creation timed out');
      socket.disconnect();
      resolve(false);
    }, config.timeout);
    
    socket.on('connect', () => {
      console.log(`✅ WebSocket connected for room test with ID: ${socket.id}`);
      
      const testRoomId = `test-room-${Date.now()}`;
      const testUserId = `test-user-${Date.now()}`;
      
      console.log(`   Joining test room: ${testRoomId}`);
      socket.emit('joinRoom', {
        roomId: testRoomId,
        userId: testUserId,
        userName: 'Test User',
        userEmail: 'TU'
      });
      
      socket.once('routerRtpCapabilities', (data) => {
        console.log('✅ Received router RTP capabilities');
        clearTimeout(timeout);
        socket.disconnect();
        resolve(true);
      });
      
      socket.once('error', (error) => {
        console.error(`Room creation error: ${error.message}`);
        clearTimeout(timeout);
        socket.disconnect();
        resolve(false);
      });
    });
    
    socket.on('connect_error', (error) => {
      console.error(`WebSocket connection error: ${error.message}`);
      clearTimeout(timeout);
      socket.disconnect();
      resolve(false);
    });
  });
}

async function runTests() {
  console.log('starting server tests...\n');
  
  const healthResult = await testHealthEndpoint();
  const socketResult = await testWebSocketConnection();
  const roomResult = await testRoomCreation();
  
  console.log('\n📊 Test Results:');
  console.log(`   Health Endpoint: ${healthResult ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   WebSocket Connection: ${socketResult ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Room Creation: ${roomResult ? '✅ PASS' : '❌ FAIL'}`);
  
  const overallResult = healthResult && socketResult && roomResult;
  console.log(`\n${overallResult ? '✅ All tests passed!' : '❌ Some tests failed!'}`);
  
  if (!overallResult) {
    console.log('\n🔧 Troubleshooting Tips:');
    console.log('   1. Make sure the server is running');
    console.log('   2. Check if the server URL is correct');
    console.log('   3. Verify that the server has the required endpoints');
    console.log('   4. Check server logs for errors');
    console.log('   5. Ensure CORS is properly configured');
  }
  
  process.exit(overallResult ? 0 : 1);
}

let fetchFn;
(async () => {
  try {
    const fetchModule = await import('node-fetch');
    fetchFn = fetchModule.default;
    await runTests();
  } catch (error) {
    console.error("failed for nodefetch lol", error.message);
    process.exit(1);
  }
})();
