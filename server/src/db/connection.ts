import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Process-wide database connection and the data directory chosen at startup.
interface DatabaseState {
  connection: Database.Database;
  dataDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));
let state: DatabaseState | undefined;

// Open the database once and reuse its connection.
export function openDatabase(): Database.Database {
  if (state) return state.connection;

  const dataDir = process.env.TAGGER_DATA_DIR ?? join(here, '..', '..');
  const databasePath = process.env.DATABASE_PATH ?? join(dataDir, 'program.db');
  const connection = new Database(databasePath);
  state = { connection, dataDir };
  return connection;
}

export function closeDatabase(): void {
  if (!state) return;
  state.connection.close();
  state = undefined;
}

// Fail early if startup has not initialized the database.
function getInitializedState(): DatabaseState {
  if (!state) {
    throw new Error(
      'Database is not initialized. Call initializeDatabase() before using database modules.',
    );
  }
  return state;
}

export function getDatabase(): Database.Database {
  return getInitializedState().connection;
}

export function getDataDir(): string {
  return getInitializedState().dataDir;
}
