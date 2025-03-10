const fs = require('fs');
const { execSync } = require('child_process');

const HEROKU_APP_NAME = 'mediasoup';

function runCommand(command) {
  console.log(`> ${command}`);
  try {
    const output = execSync(command, { encoding: 'utf8' });
    console.log(output);
    return output;
  } catch (error) {
    console.error(`Command failed: ${error.message}`);
    if (error.stdout) console.log(`stdout: ${error.stdout}`);
    if (error.stderr) console.error(`stderr: ${error.stderr}`);
    throw error;
  }
}

try {
  runCommand('heroku --version');
} catch (error) {
  console.error('Heroku CLI is not installed. Please install it first.');
  process.exit(1);
}

async function deploy() {
  console.log('Starting MediaSoup deployment to Heroku...');
  
  try {
    runCommand('heroku auth:whoami');
  } catch (error) {
    console.error('Not logged in to Heroku. Please run "heroku login" first.');
    process.exit(1);
  }

  try {
    runCommand(`heroku apps:info -a ${HEROKU_APP_NAME}`);
    console.log(`Using existing app: ${HEROKU_APP_NAME}`);
  } catch (error) {
    console.log(`Creating new Heroku app: ${HEROKU_APP_NAME}`);
    runCommand(`heroku apps:create ${HEROKU_APP_NAME}`);
  }

  console.log('Setting up buildpacks...');
  runCommand(`heroku buildpacks:clear -a ${HEROKU_APP_NAME}`);
  runCommand(`heroku buildpacks:add heroku/nodejs -a ${HEROKU_APP_NAME}`);
  
  console.log('Setting environment variables...');
  runCommand(`heroku config:set ANNOUNCED_IP=null -a ${HEROKU_APP_NAME}`);
  runCommand(`heroku config:set NUM_WORKERS=1 -a ${HEROKU_APP_NAME}`);
  
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  runCommand(`heroku config:set FRONTEND_URL="${frontendUrl}" -a ${HEROKU_APP_NAME}`);
  
  console.log('Setting Heroku configs for WebRTC...');
  
  // runCommand(`heroku ps:type standard-1x -a ${HEROKU_APP_NAME}`);
  
  console.log('Deploying to Heroku...');
  runCommand(`git push heroku master`);
  
  runCommand(`heroku open -a ${HEROKU_APP_NAME}`);
  
  console.log('\nDeployment completed successfully!');
  console.log(`\nYour MediaSoup WebRTC server is running at: https://${HEROKU_APP_NAME}.herokuapp.com`);
  console.log('\nIMPORTANT: Remember to set your NEXT_PUBLIC_SOCKET_URL environment variable in your frontend app to:');
  console.log(`https://${HEROKU_APP_NAME}.herokuapp.com`);
}

deploy().catch(error => {
  console.error('Deployment failed:', error);
  process.exit(1);
});