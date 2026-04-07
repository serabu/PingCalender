"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const database_1 = require("./database");
const handlers_1 = require("./handlers");
const scheduler_1 = require("./scheduler");
dotenv_1.default.config();
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = Number.parseInt(process.env.PORT || '3000');
if (!TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set in .env file');
    process.exit(1);
}
// Инициализация бота
const bot = new node_telegram_bot_api_1.default(TOKEN, { polling: true });
// Express сервер для пингов Render
const app = (0, express_1.default)();
app.get('/ping', async (req, res) => {
    await (0, scheduler_1.checkReminders)(bot);
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
    await (0, database_1.initDatabase)();
    (0, handlers_1.setupHandlers)(bot);
    (0, scheduler_1.startScheduler)(bot);
    console.log('✅ Bot is ready!');
}
startBot().catch(console.error);
// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    process.exit(0);
});
