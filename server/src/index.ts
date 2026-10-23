import { closeDatabase, initializeDatabase } from './db';
import { createApp } from './app';
import { startAutoRescan } from './rescan';
import { startScheduledPlayouts } from './scheduledPlayout';

const PORT = 3001;

// Prepare durable state and background maintenance before accepting requests.
initializeDatabase();
const stopAutoRescan = startAutoRescan();
const stopScheduledPlayouts = startScheduledPlayouts();

// Nginx basic auth assumes this server is reachable only through the loopback proxy.
const server = createApp().listen(PORT, '127.0.0.1', () =>
  console.log(`program server: http://localhost:${PORT}`),
);

let stopping = false;
// Stop each owned resource once when systemd or the terminal requests shutdown.
function stopServer(): void {
  if (stopping) return;
  stopping = true;
  stopAutoRescan();
  stopScheduledPlayouts();
  server.close((error) => {
    try {
      closeDatabase();
    } catch (databaseError) {
      console.error('Database shutdown failed', databaseError);
      process.exitCode = 1;
    }
    if (error) {
      console.error('Program server shutdown failed', error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', stopServer);
process.once('SIGTERM', stopServer);
