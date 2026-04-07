const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
require('dotenv').config();

// Конфигурация
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

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

// Express сервер для пингов Render
const app = express();
app.get('/ping', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'alive', timestamp: new Date() }));
app.listen(PORT, () => console.log(`🏓 Ping server on port ${PORT}`));

// Инициализация базы данных
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

// Проверка и отправка напоминаний
async function checkReminders() {
    const client = await pool.connect();
    try {
        const now = Date.now();
        const result = await client.query(
            'SELECT id, chat_id, date, time, message FROM reminders WHERE notify_at <= $1',
            [now]
        );
        
        for (const reminder of result.rows) {
            try {
                await bot.sendMessage(
                    reminder.chat_id,
                    `🔔 *НАПОМИНАНИЕ!*\n📅 ${reminder.date} в ${reminder.time}\n📝 ${reminder.message}`,
                    { parse_mode: 'Markdown' }
                );
                await client.query('DELETE FROM reminders WHERE id = $1', [reminder.id]);
                console.log(`✅ Sent reminder ${reminder.id}`);
            } catch (error) {
                console.error(`Failed to send reminder ${reminder.id}:`, error);
            }
        }
    } finally {
        client.release();
    }
}

// Запуск проверки каждую минуту
setInterval(checkReminders, 60 * 1000);

// Команды бота
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `📅 *PingCalendar Bot - Ваш личный календарь*\n\n` +
        `*Доступные команды:*\n` +
        `/add ДД.ММ.ГГГГ ЧЧ:ММ Текст - Добавить напоминание\n` +
        `/list - Показать все напоминания\n` +
        `/delete ID - Удалить напоминание\n\n` +
        `*Пример:*\n` +
        `/add 31.12.2024 23:59 Запустить салют`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1];
    
    const dateRegex = /(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(.+)/;
    const parsed = input.match(dateRegex);
    
    if (!parsed) {
        bot.sendMessage(chatId, '❌ Неверный формат!\nИспользуйте: `/add ДД.ММ.ГГГГ ЧЧ:ММ Текст`', { parse_mode: 'Markdown' });
        return;
    }
    
    const [_, date, time, message] = parsed;
    const [day, month, year] = date.split('.');
    const [hours, minutes] = time.split(':');
    
    const notifyAt = new Date(year, month-1, day, hours, minutes).getTime();
    
    if (isNaN(notifyAt)) {
        bot.sendMessage(chatId, '❌ Неверная дата!');
        return;
    }
    
    if (notifyAt < Date.now()) {
        bot.sendMessage(chatId, '❌ Дата и время уже прошли!');
        return;
    }
    
    try {
        const result = await pool.query(
            `INSERT INTO reminders (chat_id, date, time, message, notify_at) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [chatId, date, time, message, notifyAt]
        );
        bot.sendMessage(chatId, `✅ Напоминание добавлено (ID: ${result.rows[0].id})\n📅 ${date} в ${time}\n📝 ${message}`);
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка при сохранении');
    }
});

bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const result = await pool.query(
            `SELECT id, date, time, message 
             FROM reminders 
             WHERE chat_id = $1 
             ORDER BY notify_at ASC`,
            [chatId]
        );
        
        if (result.rows.length === 0) {
            bot.sendMessage(chatId, '📭 У вас нет запланированных напоминаний');
            return;
        }
        
        let response = '📋 *Ваши напоминания:*\n\n';
        result.rows.forEach(row => {
            response += `*${row.id}.* ${row.date} ${row.time} - ${row.message}\n`;
        });
        response += '\nУдалить: `/delete ID`';
        
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка получения списка');
    }
});

bot.onText(/\/delete (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = parseInt(match[1]);
    
    try {
        const result = await pool.query(
            'DELETE FROM reminders WHERE id = $1 AND chat_id = $2',
            [id, chatId]
        );
        
        if (result.rowCount > 0) {
            bot.sendMessage(chatId, `✅ Напоминание ${id} удалено`);
        } else {
            bot.sendMessage(chatId, `❌ Напоминание ${id} не найдено`);
        }
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка при удалении');
    }
});

// Запуск
async function start() {
    await initDatabase();
    console.log('🤖 Bot is ready!');
    console.log('📅 Calendar bot started');
    await checkReminders(); // Первая проверка
}

start().catch(console.error);