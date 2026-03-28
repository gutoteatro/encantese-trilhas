import mysql from 'mysql2/promise';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'encantese_trilhas';

let pool;

export async function initializeDatabase() {
  try {
    const bootstrapConnection = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      multipleStatements: true,
    });

    await bootstrapConnection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    await bootstrapConnection.end();
  } catch {
    console.log(`[db] Skipping DB creation - usually lacking global permissions or already exists (Easypanel).`);
  }

  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS themes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      theme_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      duration VARCHAR(16) NOT NULL DEFAULT '--:--',
      url TEXT NOT NULL,
      drive_file_id VARCHAR(128) NULL,
      source VARCHAR(64) NOT NULL DEFAULT 'drive-link',
      content_hash VARCHAR(128) NULL,
      added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tracks_theme_id (theme_id),
      INDEX idx_tracks_theme_hash_added (theme_id, content_hash, added_at),
      CONSTRAINT fk_tracks_theme
        FOREIGN KEY (theme_id)
        REFERENCES themes(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);

  const [contentHashColumnRows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'tracks'
       AND COLUMN_NAME = 'content_hash'`,
    [DB_NAME],
  );

  if (Number(contentHashColumnRows?.[0]?.count || 0) === 0) {
    await pool.query('ALTER TABLE tracks ADD COLUMN content_hash VARCHAR(128) NULL AFTER source');
  }

  const [hashIndexRows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'tracks'
       AND INDEX_NAME = 'idx_tracks_theme_hash_added'`,
    [DB_NAME],
  );

  if (Number(hashIndexRows?.[0]?.count || 0) === 0) {
    await pool.query('ALTER TABLE tracks ADD INDEX idx_tracks_theme_hash_added (theme_id, content_hash, added_at)');
  }

  return pool;
}

export function getDb() {
  if (!pool) {
    throw new Error('Database pool not initialized.');
  }

  return pool;
}
