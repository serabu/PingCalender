const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
require('dotenv').config();

// Конфигурация
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MOSCOW_OFFSET = 3; // Москва UTC+3

if (!TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN не найден!');
    process.exit(1);
}

// Инициализация бота
const bot = new TelegramBot(TOKEN, { polling: true });

// Подключение к БД
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Express сервер для пингов
const app = express();
app.get('/ping', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'alive', timestamp: new Date() }));
app.listen(PORT, () => console.log(`🏓 Ping server on port ${PORT}`));

// Инициализация БД
async function initDatabase() {
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

// Преобразование московского времени в UTC timestamp
function moscowToUTC(year, month, day, hours, minutes) {
    // Создаём дату в локальном времени (но сервер воспринимает как UTC)
    const localDate = new Date(Date.UTC(year, month, day, hours, minutes));
    // Вычитаем смещение Москвы (3 часа) -> получаем UTC
    const utcTimestamp = localDate.getTime() - MOSCOW_OFFSET * 60 * 60 * 1000;
    return utcTimestamp;
}

// Преобразование UTC timestamp в московское время (для отображения)
function utcToMoscow(utcTimestamp) {
    const moscowTime = new Date(utcTimestamp + MOSCOW_OFFSET * 60 * 60 * 1000);
    return moscowTime;
}

// Проверка и отправка напоминаний
async function checkReminders() {
    console.log(`🔍 [${new Date().toISOString()}] Checking reminders...`);
    const client = await pool.connect();
    try {
        const now = Date.now(); // UTC
        console.log(`   Current UTC timestamp: ${now}`);
        const result = await client.query(
            'SELECT id, chat_id, date, time, message, notify_at FROM reminders WHERE notify_at <= $1',
            [now]
        );
        console.log(`   Found ${result.rows.length} reminder(s) to send.`);
        for (const reminder of result.rows) {
            console.log(`   → Processing reminder ID ${reminder.id}: ${reminder.date} ${reminder.time}`);
            try {
                await bot.sendMessage(
                    reminder.chat_id,
                    `🔔 *НАПОМИНАНИЕ!*\n📅 ${reminder.date} в ${reminder.time} (МСК)\n📝 ${reminder.message}`,
                    { parse_mode: 'Markdown' }
                );
                await client.query('DELETE FROM reminders WHERE id = $1', [reminder.id]);
                console.log(`   ✅ Sent and deleted reminder ${reminder.id}`);
            } catch (error) {
                console.error(`   ❌ Failed: ${error.message}`);
            }
        }
    } catch (error) {
        console.error('❌ Error in checkReminders:', error);
    } finally {
        client.release();
    }
}

setInterval(checkReminders, 60 * 1000);

// ---- Команды ----

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `📅 *PingCalendar Bot - Ваш личный календарь (Московское время)*\n\n` +
        `*Команды:*\n` +
        `/add ДД.ММ.ГГГГ ЧЧ:ММ Текст - добавить напоминание (МСК)\n` +
        `/list - показать все (МСК)\n` +
        `/delete ID - удалить\n` +
        `/time - показать серверное время (UTC) и МСК\n\n` +
        `Пример: /add 31.12.2025 23:59 Встретить Новый год`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/time/, (msg) => {
    const nowUTC = Date.now();
    const nowMoscow = utcToMoscow(nowUTC);
    bot.sendMessage(msg.chat.id,
        `🕐 *Серверное время (UTC):* ${new Date(nowUTC).toUTCString()}\n` +
        `🕒 *Московское время (МСК):* ${nowMoscow.toLocaleString()}\n\n` +
        `✅ Все напоминания автоматически переводятся из МСК в UTC. Вводите время по Москве.`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1];
    const dateRegex = /(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(.+)/;
    const parsed = input.match(dateRegex);
    if (!parsed) {
        bot.sendMessage(chatId, '❌ Формат: `/add ДД.ММ.ГГГГ ЧЧ:ММ Текст`', { parse_mode: 'Markdown' });
        return;
    }
    const [_, date, time, message] = parsed;
    const [day, month, year] = date.split('.');
    const [hours, minutes] = time.split(':');
    
    // Преобразуем московское время в UTC
    const notifyAtUTC = moscowToUTC(parseInt(year), parseInt(month)-1, parseInt(day), parseInt(hours), parseInt(minutes));
    const nowUTC = Date.now();
    
    console.log(`[ADD] МСК: ${date} ${time} -> UTC timestamp: ${notifyAtUTC}, сейчас UTC: ${nowUTC}, разница: ${notifyAtUTC - nowUTC}ms`);
    
    if (isNaN(notifyAtUTC)) {
        bot.sendMessage(chatId, '❌ Неверная дата');
        return;
    }
    if (notifyAtUTC < nowUTC) {
        const moscowNow = utcToMoscow(nowUTC);
        bot.sendMessage(chatId, `❌ Это время уже прошло (МСК: ${moscowNow.toLocaleString()})`);
        return;
    }
    
    try {
        const result = await pool.query(
            `INSERT INTO reminders (chat_id, date, time, message, notify_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [chatId, date, time, message, notifyAtUTC]
        );
        bot.sendMessage(chatId, `✅ Напоминание добавлено (ID: ${result.rows[0].id})\n📅 ${date} в ${time} (МСК)\n📝 ${message}`);
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, '❌ Ошибка БД');
    }
});

bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const result = await pool.query(
            `SELECT id, date, time, message, notify_at FROM reminders WHERE chat_id = $1 ORDER BY notify_at ASC`,
            [chatId]
        );
        if (result.rows.length === 0) {
            bot.sendMessage(chatId, '📭 Нет напоминаний');
            return;
        }
        let response = '📋 *Ваши напоминания (МСК):*\n\n';
        for (const row of result.rows) {
            response += `*${row.id}.* ${row.date} ${row.time} - ${row.message}\n`;
        }
        response += '\nУдалить: `/delete ID`';
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, '❌ Ошибка');
    }
});

bot.onText(/\/delete (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = parseInt(match[1]);
    try {
        const result = await pool.query(`DELETE FROM reminders WHERE id = $1 AND chat_id = $2`, [id, chatId]);
        if (result.rowCount > 0) {
            bot.sendMessage(chatId, `✅ Напоминание ${id} удалено`);
        } else {
            bot.sendMessage(chatId, `❌ Не найдено`);
        }
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, '❌ Ошибка');
    }
});

// Запуск
async function start() {
    await initDatabase();
    console.log('🤖 Bot ready (Moscow time mode)');
    await checkReminders();
}
start().catch(console.error);