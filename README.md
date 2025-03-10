# WebRTC Video Call Application with MediaSoup

This is a production-ready WebRTC video call application using MediaSoup as the SFU (Selective Forwarding Unit). The application supports video calls, audio calls, screen sharing, and text chat.

## Features

- Multi-user video conferences
- Screen sharing
- Text chat
- Media device control (mute/unmute, video on/off)
- Adaptive layout
- Connection state notifications
- Automatic reconnection
- Works across different network conditions

## Project Structure

The project consists of two main parts:

1. **Server**: Node.js server running MediaSoup SFU
2. **Client**: Next.js frontend with WebRTC client implementation

## Prerequisites

- Node.js 16+
- npm or yarn
- For development: a local environment with proper network access

## Setup and Development

### Local Development

1. Clone the repository:
   ```
   git clone <repository-url>
   cd <repository-name>
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the server:
   ```
   npm run start:server
   ```

4. In a separate terminal, start the client:
   ```
   npm run dev
   ```

5. Open your browser at `http://localhost:3000`

### Production Deployment

#### Deploying to Heroku

1. Make sure you have the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) installed and you're logged in:
   ```
   heroku login
   ```

2. Edit the `deploy-heroku.js` file and update the `HEROKU_APP_NAME` variable to your desired app name.

3. Run the deployment script:
   ```
   node deploy-heroku.js
   ```

4. After deployment, set your frontend environment variable:
   ```
   NEXT_PUBLIC_SOCKET_URL=https://<your-app-name>.herokuapp.com
   ```

#### Manual Deployment

1. Deploy the server to your hosting provider
2. Set the following environment variables:
   - `PORT`: Port to run the server on (default: 3001)
   - `ANNOUNCED_IP`: Public IP of your server (can be null for Heroku)
   - `FRONTEND_URL`: URL of your frontend application
   - `NUM_WORKERS`: Number of MediaSoup workers to create (default: 1)

3. Deploy the client and set:
   - `NEXT_PUBLIC_SOCKET_URL`: URL where your server is deployed

## Troubleshooting

### Connection Issues

If you're experiencing connection issues:

1. **Check server logs**: Look for any errors in the server logs
2. **Verify STUN/TURN servers**: Ensure you have proper ICE servers configured
3. **Check firewalls**: Make sure your server allows UDP traffic on the required ports
4. **Heroku deployment**: Ensure you've set `ANNOUNCED_IP=null` and are using the WebSocket protocol

### Heroku-Specific Issues

Heroku has some limitations for WebRTC applications:

1. **Dyno restart**: Heroku dynos restart periodically, which can disconnect active calls
2. **Connection timeout**: Heroku has a 30-second timeout for connections
3. **IP addressing**: Heroku uses multiple proxy layers, making ICE negotiation tricky

Solutions:
- Set `ANNOUNCED_IP=null` as shown in the deployment script
- Consider using a dedicated TURN server
- Use Professional or Performance dynos for better reliability

### Browser Compatibility

- **Chrome/Edge/Opera**: Full support
- **Firefox**: Mostly supported (some screen sharing features may behave differently)
- **Safari**: Supported, but some features may require additional permissions

## Advanced Configuration

### Customizing MediaSoup Settings

Edit the `mediasoupOptions` object in `server.js` to customize:

- RTC port range
- Media codecs
- Bitrate limits
- Log levels
- Transport settings

### Adding TURN Servers

For clients behind restrictive firewalls, add TURN servers to improve connectivity:

1. Sign up for a TURN service (like Twilio or CoTURN)
2. Add the TURN servers in `lib/webrtc-client.ts`

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [MediaSoup](https://mediasoup.org/) - SFU implementation
- [WebRTC](https://webrtc.org/) - The underlying technology
- [Socket.IO](https://socket.io/) - Signaling mechanism
