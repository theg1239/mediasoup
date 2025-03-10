const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = {
  server: {
    script: 'server.js',
    logsDir: path.join(__dirname, 'public', 'logs'),
    startupTime: 5000,
    maxRestarts: 5,
    restartDelay: 5000,
    healthCheck: {
      url: 'http://localhost:' + (process.env.PORT || 3001) + '/health',
      interval: 30000, // 30 seconds
      grace: 10000, // 10 seconds
      timeout: 5000, // 5 seconds
    }
  }
};

// Ensure the public logs directory exists
if (!fs.existsSync(config.server.logsDir)) {
  fs.mkdirSync(config.server.logsDir, { recursive: true });
}

const date = new Date().toISOString().replace(/:/g, '-').split('.')[0];
const stdout = fs.createWriteStream(path.join(config.server.logsDir, `server-${date}-out.log`));
const stderr = fs.createWriteStream(path.join(config.server.logsDir, `server-${date}-err.log`));

let serverProcess = null;
let restartCount = 0;
let shuttingDown = false;
let healthCheckTimer = null;
let startupTimer = null;

async function performHealthCheck() {
  try {
    const response = await fetch(config.server.healthCheck.url, { 
      timeout: config.server.healthCheck.timeout 
    });
    
    if (!response.ok) {
      console.error(`Health check failed with status: ${response.status}`);
      handleServerFailure('Health check failed');
    }
  } catch (error) {
    console.error(`Health check error: ${error.message}`);
    handleServerFailure('Health check error');
  }
}

function startServer() {
  console.log(`Starting server (attempt ${restartCount + 1}/${config.server.maxRestarts})...`);
  
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (startupTimer) clearTimeout(startupTimer);
  
  serverProcess = spawn('node', [config.server.script], {
    env: { 
      ...process.env,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  serverProcess.stdout.pipe(stdout);
  serverProcess.stderr.pipe(stderr);
  
  serverProcess.stdout.on('data', (data) => {
    process.stdout.write(data);
  });
  
  serverProcess.stderr.on('data', (data) => {
    process.stderr.write(data);
  });
  
  startupTimer = setTimeout(() => {
    console.log('Server started successfully');
    restartCount = 0; 
    setTimeout(() => {
      healthCheckTimer = setInterval(performHealthCheck, config.server.healthCheck.interval);
    }, config.server.healthCheck.grace);
  }, config.server.startupTime);
  
  serverProcess.on('exit', (code, signal) => {
    if (shuttingDown) return;
    
    console.error(`Server process exited with code ${code} and signal ${signal}`);
    handleServerFailure('Process exit');
  });
  
  serverProcess.on('error', (error) => {
    if (shuttingDown) return;
    
    console.error(`Server process error: ${error.message}`);
    handleServerFailure('Process error');
  });
}

function handleServerFailure(reason) {
  console.error(`Server failure detected: ${reason}`);
  
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (startupTimer) clearTimeout(startupTimer);
  
  if (serverProcess) {
    try {
      serverProcess.kill('SIGTERM');
    } catch (e) {}
  }
  
  restartCount++;
  
  if (restartCount >= config.server.maxRestarts) {
    console.error(`Maximum restart attempts (${config.server.maxRestarts}) reached. Giving up.`);
    process.exit(1);
  }
  
  const delay = config.server.restartDelay * Math.pow(1.5, restartCount - 1);
  console.log(`Restarting server in ${Math.round(delay / 1000)} seconds...`);
  
  setTimeout(startServer, delay);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  shuttingDown = true;
  
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (startupTimer) clearTimeout(startupTimer);
  
  if (serverProcess) {
    console.log('Stopping server process...');
    serverProcess.kill('SIGTERM');
    
    setTimeout(() => {
      if (serverProcess) {
        console.log('Forcing server process termination');
        serverProcess.kill('SIGKILL');
      }
      
      stdout.end();
      stderr.end();
      
      process.exit(0);
    }, 5000);
  } else {
    stdout.end();
    stderr.end();
    
    process.exit(0);
  }
}

startServer();
