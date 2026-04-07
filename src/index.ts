import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import dotenv from 'dotenv';
import { initDatabase } from './database';
import { setupHandlers } from './handlers';
import { startScheduler, checkReminders } from './scheduler';

dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = Number.parseInt(process.env.PORT || '3000');

if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not set in .env file');
  process.exit(1);
}

// Инициализация бота
const bot = new TelegramBot(TOKEN, { polling: true });

// Express сервер для пингов Render
const app = express();

app.get('/ping', async (req, res) => {
  await checkReminders(bot);
  res.status(200).send('OK');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🏓 Ping server running on port ${PORT}`);
});

// Запуск бота
async function startBot() {
  console.log('🤖 Starting PingCalendar bot...');
  
  await initDatabase();
  setupHandlers(bot);
  startScheduler(bot);
  
  console.log('✅ Bot is ready!');
}

startBot().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});