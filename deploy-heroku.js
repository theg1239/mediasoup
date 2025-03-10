const fs = require('fs');
const { spawnSync } = require('child_process');

const HEROKU_APP_NAME = process.env.HEROKU_APP_NAME || 'mediasoup';

function runCommand(command) {
  console.log(`> ${command}`);
  const result = spawnSync(command, { shell: true, encoding: 'utf8' });

  if (result.error) {
    console.error(`Error executing command: ${result.error}`);
    throw result.error;
  }

  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);

  if (command === 'heroku --version' && result.stdout.includes('heroku/')) {
    return result.stdout;
  }
  if (command === 'heroku auth:whoami' && result.stdout.trim() !== '') {
    return result.stdout;
  }
  if (command.startsWith('git push heroku') &&
      ((result.stdout && result.stdout.includes('Everything up-to-date')) ||
       (result.stderr && result.stderr.includes('Everything up-to-date')))) {
    return result.stdout;
  }
  if (command.startsWith('heroku apps:info') && result.stdout.includes('Git URL:')) {
    return result.stdout;
  }
  if (command.startsWith('heroku buildpacks:clear') && result.stdout.includes('Buildpacks cleared.')) {
    return result.stdout;
  }
  if (command.startsWith('heroku buildpacks:add') && result.stdout.includes('Buildpack added.')) {
    return result.stdout;
  }
  if (command.startsWith('heroku config:set') && result.stdout.includes('done')) {
    return result.stdout;
  }

  if (result.status !== 0) {
    throw new Error(`Command exited with code ${result.status}`);
  }
  return result.stdout;
}

try {
  const versionOutput = runCommand('heroku --version');
  if (!versionOutput.includes('heroku/')) {
    console.error('Heroku CLI is not installed. Please install it first.');
    process.exit(1);
  }
} catch (error) {
  console.error('Heroku CLI is not installed. Please install it first.');
  process.exit(1);
}

async function deploy() {
  console.log('Starting MediaSoup deployment to Heroku...');

  let auth;
  try {
    auth = runCommand('heroku auth:whoami').trim();
    if (!auth) {
      console.error('Not logged in to Heroku. Please run "heroku login" first.');
      process.exit(1);
    }
  } catch (error) {
    console.error('Not logged in to Heroku. Please run "heroku login" first.');
    process.exit(1);
  }
  console.log(`Logged in as: ${auth}`);

  let appInfo;
  try {
    appInfo = runCommand(`heroku apps:info -a ${HEROKU_APP_NAME}`);
    console.log(`Using existing app: ${HEROKU_APP_NAME}`);
  } catch (error) {
    console.log(`App ${HEROKU_APP_NAME} not found. Creating new Heroku app...`);
    try {
      appInfo = runCommand(`heroku apps:create ${HEROKU_APP_NAME}`);
      console.log(`Created new app: ${HEROKU_APP_NAME}`);
    } catch (err) {
      if (err.message.includes('Name') && err.message.includes('already taken')) {
        console.error(`App name ${HEROKU_APP_NAME} is already taken. Please choose another name.`);
        process.exit(1);
      }
      throw err;
    }
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
  try {
    runCommand(`git push heroku master`);
  } catch (error) {
    if (error.message.includes('Everything up-to-date')) {
      console.log('Nothing to push; repository is already up-to-date.');
    } else {
      throw error;
    }
  }

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
