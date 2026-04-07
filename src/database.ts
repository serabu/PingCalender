import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS reminders (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        date VARCHAR(10) NOT NULL,
        time VARCHAR(5) NOT NULL,
        message TEXT NOT NULL,
        notify_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_notify_at ON reminders(notify_at);
      CREATE INDEX IF NOT EXISTS idx_chat_id ON reminders(chat_id);
    `);
    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

export async function addReminder(chatId: number, date: string, time: string, message: string, notifyAt: number) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO reminders (chat_id, date, time, message, notify_at) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [chatId, date, time, message, notifyAt]
    );
    return result.rows[0].id;
  } finally {
    client.release();
  }
}

export async function getReminders(chatId: number) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, date, time, message, notify_at 
       FROM reminders 
       WHERE chat_id = $1 
       ORDER BY notify_at ASC`,
      [chatId]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

export async function deleteReminder(id: number, chatId: number) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `DELETE FROM reminders WHERE id = $1 AND chat_id = $2`,
      [id, chatId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function getPendingReminders() {
  const client = await pool.connect();
  try {
    const now = Date.now();
    const result = await client.query(
      `SELECT id, chat_id, date, time, message, notify_at 
       FROM reminders 
       WHERE notify_at <= $1`,
      [now]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

export async function removeSentReminder(id: number) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM reminders WHERE id = $1`, [id]);
  } finally {
    client.release();
  }
}