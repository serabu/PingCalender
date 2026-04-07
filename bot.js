const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const express = require("express");
require("dotenv").config();

// ========== КОНФИГУРАЦИЯ ==========
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MOSCOW_OFFSET = 3; // Москва UTC+3

if (!TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN не найден!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Express для пингов
const app = express();
app.get("/ping", (req, res) => res.send("OK"));
app.get("/health", (req, res) =>
  res.json({ status: "alive", timestamp: new Date() }),
);
app.listen(PORT, () => console.log(`🏓 Ping server on port ${PORT}`));

// ========== ХРАНЕНИЕ СОСТОЯНИЙ ПОЛЬЗОВАТЕЛЕЙ ==========
// Для многошагового добавления напоминания
const userStates = new Map(); // key: chatId, value: { step, date, timeMode, tempDate }

// ========== БАЗА ДАННЫХ ==========
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
    console.log("✅ Database initialized");
  } finally {
    client.release();
  }
}

// ========== ВРЕМЕННЫЕ ФУНКЦИИ (МСК ↔ UTC) ==========
function moscowToUTC(year, month, day, hours, minutes) {
  const localDate = new Date(Date.UTC(year, month, day, hours, minutes));
  return localDate.getTime() - MOSCOW_OFFSET * 60 * 60 * 1000;
}

function utcToMoscow(utcTimestamp) {
  return new Date(utcTimestamp + MOSCOW_OFFSET * 60 * 60 * 1000);
}

// ========== ОЧИСТКА ПРОСРОЧЕННЫХ НАПОМИНАНИЙ ==========
async function cleanExpiredReminders() {
  const client = await pool.connect();
  try {
    const now = Date.now();
    const result = await client.query(
      "DELETE FROM reminders WHERE notify_at < $1",
      [now],
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned ${result.rowCount} expired reminders`);
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  } finally {
    client.release();
  }
}
// Запускаем очистку раз в час
setInterval(cleanExpiredReminders, 60 * 60 * 1000);
cleanExpiredReminders(); // сразу при старте

// ========== ПРОВЕРКА И ОТПРАВКА НАПОМИНАНИЙ ==========
async function checkReminders() {
  console.log(`🔍 [${new Date().toISOString()}] Checking reminders...`);
  const client = await pool.connect();
  try {
    const now = Date.now();
    const result = await client.query(
      "SELECT id, chat_id, date, time, message, notify_at FROM reminders WHERE notify_at <= $1",
      [now],
    );
    console.log(`   Found ${result.rows.length} reminder(s) to send.`);
    for (const reminder of result.rows) {
      try {
        await bot.sendMessage(
          reminder.chat_id,
          `🔔 *НАПОМИНАНИЕ!*\n📅 ${reminder.date} в ${reminder.time} (МСК)\n📝 ${reminder.message}`,
          { parse_mode: "Markdown" },
        );
        await client.query("DELETE FROM reminders WHERE id = $1", [
          reminder.id,
        ]);
        console.log(`   ✅ Sent and deleted reminder ${reminder.id}`);
      } catch (error) {
        console.error(`   ❌ Failed: ${error.message}`);
      }
    }
  } catch (error) {
    console.error("❌ Error in checkReminders:", error);
  } finally {
    client.release();
  }
}
setInterval(checkReminders, 60 * 1000);

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ СОЗДАНИЯ НАПОМИНАНИЙ ==========
// Создание одного напоминания
async function createReminder(chatId, dateStr, timeStr, message) {
  const [day, month, year] = dateStr.split(".");
  const [hours, minutes] = timeStr.split(":");
  const notifyAtUTC = moscowToUTC(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hours),
    parseInt(minutes),
  );
  const nowUTC = Date.now();
  if (notifyAtUTC < nowUTC) {
    return false; // время прошло
  }
  await pool.query(
    `INSERT INTO reminders (chat_id, date, time, message, notify_at) VALUES ($1, $2, $3, $4, $5)`,
    [chatId, dateStr, timeStr, message, notifyAtUTC],
  );
  return true;
}

// Создание напоминаний на дату (с временами по умолчанию 8:00 и 15:00)
async function createDefaultReminders(chatId, dateStr, message) {
  const times = ["08:00", "15:00"];
  let created = 0;
  for (const t of times) {
    const success = await createReminder(chatId, dateStr, t, message);
    if (success) created++;
  }
  return created;
}

// ========== КОМАНДЫ И ИНЛАЙН-КЛАВИАТУРЫ ==========

// Главное меню (reply-клавиатура)
const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "➕ Добавить напоминание" }],
      [{ text: "📋 Список напоминаний" }],
      [{ text: "🕒 Текущее время" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📅 *PingCalendar Bot*\n\n` +
      `Я помню ваши дела и напомню вовремя.\n` +
      `🕒 *Время указывайте по МОСКВЕ (МСК)*\n\n` +
      `Используйте кнопки меню для управления.`,
    { parse_mode: "Markdown", ...mainMenuKeyboard },
  );
});

// Обработка нажатий на reply-кнопки
bot.on("message", async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;
  if (!text) return;

  if (text === "➕ Добавить напоминание") {
    userStates.set(chatId, { step: "awaiting_date" });
    bot.sendMessage(
      chatId,
      `📅 Введите *дату* в формате ДД.ММ.ГГГГ (например, 31.12.2025)\nИли нажмите /cancel для отмены.`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  if (text === "📋 Список напоминаний") {
    await showRemindersList(chatId);
    return;
  }
  if (text === "🕒 Текущее время") {
    const nowUTC = Date.now();
    const nowMoscow = utcToMoscow(nowUTC);
    bot.sendMessage(
      chatId,
      `🕒 *Московское время:* ${nowMoscow.toLocaleString()}\n` +
        `🌍 *UTC:* ${new Date(nowUTC).toUTCString()}`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Обработка состояний добавления
  const state = userStates.get(chatId);
  if (state) {
    if (text === "/cancel") {
      userStates.delete(chatId);
      bot.sendMessage(chatId, "❌ Добавление отменено.", mainMenuKeyboard);
      return;
    }

    if (state.step === "awaiting_date") {
      // Проверка формата даты
      const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
      const match = text.match(dateRegex);
      if (!match) {
        bot.sendMessage(
          chatId,
          "❌ Неверный формат. Введите дату как ДД.ММ.ГГГГ (например, 31.12.2025)",
        );
        return;
      }
      const [_, day, month, year] = match;
      // Базовая проверка на существование даты
      const testDate = new Date(year, month - 1, day);
      if (testDate.getMonth() !== month - 1) {
        bot.sendMessage(
          chatId,
          "❌ Неверная дата (например, 31.02.2025 не существует)",
        );
        return;
      }
      // Сохраняем дату и переходим к запросу времени
      userStates.set(chatId, { step: "awaiting_time", date: text });
      bot.sendMessage(
        chatId,
        `🕐 Введите *время* в формате ЧЧ:ММ (например, 15:30) или нажмите "Пропустить" — тогда будут установлены напоминания на 8:00 и 15:00.\n\nПропустить: /skip`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [[{ text: "Пропустить (8:00 и 15:00)" }], ["/cancel"]],
            resize_keyboard: true,
          },
        },
      );
      return;
    }

    if (state.step === "awaiting_time") {
      let timeStr = null;
      if (text === "Пропустить (8:00 и 15:00)" || text === "/skip") {
        timeStr = null; // без времени
      } else {
        const timeRegex = /^(\d{2}):(\d{2})$/;
        const match = text.match(timeRegex);
        if (!match) {
          bot.sendMessage(
            chatId,
            '❌ Неверный формат времени. Используйте ЧЧ:ММ (например, 09:00) или нажмите "Пропустить".',
          );
          return;
        }
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
          bot.sendMessage(chatId, "❌ Часы от 00 до 23, минуты от 00 до 59");
          return;
        }
        timeStr = `${match[1]}:${match[2]}`;
      }
      userStates.set(chatId, {
        step: "awaiting_message",
        date: state.date,
        time: timeStr,
      });
      bot.sendMessage(
        chatId,
        `✏️ Введите *текст напоминания* (что нужно сделать)`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (state.step === "awaiting_message") {
      const messageText = text;
      const dateStr = state.date;
      const timeStr = state.time;
      userStates.delete(chatId);

      try {
        if (timeStr) {
          // Напоминание с конкретным временем
          const success = await createReminder(
            chatId,
            dateStr,
            timeStr,
            messageText,
          );
          if (success) {
            bot.sendMessage(
              chatId,
              `✅ Напоминание добавлено!\n📅 ${dateStr} в ${timeStr} (МСК)\n📝 ${messageText}`,
              mainMenuKeyboard,
            );
          } else {
            bot.sendMessage(
              chatId,
              `❌ Это время уже прошло (МСК). Попробуйте другую дату.`,
              mainMenuKeyboard,
            );
          }
        } else {
          // Без времени: создаём два напоминания (8:00 и 15:00)
          const createdCount = await createDefaultReminders(
            chatId,
            dateStr,
            messageText,
          );
          if (createdCount === 0) {
            bot.sendMessage(
              chatId,
              `❌ Дата ${dateStr} уже прошла (обе временные точки в прошлом).`,
              mainMenuKeyboard,
            );
          } else {
            bot.sendMessage(
              chatId,
              `✅ Добавлены напоминания на *${dateStr}* в 08:00 и 15:00 (МСК)\n📝 ${messageText}`,
              { parse_mode: "Markdown", ...mainMenuKeyboard },
            );
          }
        }
      } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, "❌ Ошибка при сохранении.", mainMenuKeyboard);
      }
      return;
    }
  }
});

// Команда /cancel
bot.onText(/\/cancel/, (msg) => {
  if (userStates.has(msg.chat.id)) {
    userStates.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, "❌ Действие отменено.", mainMenuKeyboard);
  } else {
    bot.sendMessage(msg.chat.id, "Нет активного действия.", mainMenuKeyboard);
  }
});

// Показ списка с инлайн-кнопками удаления
async function showRemindersList(chatId) {
  try {
    const result = await pool.query(
      `SELECT id, date, time, message FROM reminders WHERE chat_id = $1 ORDER BY notify_at ASC`,
      [chatId],
    );
    if (result.rows.length === 0) {
      bot.sendMessage(
        chatId,
        "📭 У вас нет запланированных напоминаний.",
        mainMenuKeyboard,
      );
      return;
    }
    for (const row of result.rows) {
      const inlineKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `❌ Удалить (ID ${row.id})`,
                callback_data: `delete_${row.id}`,
              },
            ],
          ],
        },
      };
      await bot.sendMessage(
        chatId,
        `*${row.id}.* 📅 ${row.date} в ${row.time} (МСК)\n📝 ${row.message}`,
        { parse_mode: "Markdown", ...inlineKeyboard },
      );
    }
    bot.sendMessage(
      chatId,
      `Для удаления нажмите кнопку под напоминанием.`,
      mainMenuKeyboard,
    );
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ Ошибка получения списка.", mainMenuKeyboard);
  }
}

// Обработка инлайн-кнопок удаления
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  if (data.startsWith("delete_")) {
    const id = parseInt(data.split("_")[1]);
    try {
      const result = await pool.query(
        `DELETE FROM reminders WHERE id = $1 AND chat_id = $2`,
        [id, chatId],
      );
      if (result.rowCount > 0) {
        await bot.editMessageText(`✅ Напоминание ${id} удалено`, {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: "Markdown",
        });
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Удалено!" });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "Уже удалено или не найдено",
        });
        await bot.editMessageText(`❌ Напоминание ${id} не найдено`, {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
        });
      }
    } catch (err) {
      console.error(err);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка" });
    }
  }
  // Убираем "часики" после обработки
  bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
});

// Старые текстовые команды оставляем для обратной совместимости
bot.onText(/\/list/, (msg) => showRemindersList(msg.chat.id));
bot.onText(/\/time/, (msg) => {
  const nowUTC = Date.now();
  const nowMoscow = utcToMoscow(nowUTC);
  bot.sendMessage(
    msg.chat.id,
    `🕒 *Московское время:* ${nowMoscow.toLocaleString()}\n🌍 *UTC:* ${new Date(nowUTC).toUTCString()}`,
    { parse_mode: "Markdown" },
  );
});
bot.onText(/\/add (.+)/, async (msg, match) => {
  // Старый способ через одну команду тоже поддержим
  const input = match[1];
  const parts = input.match(
    /(\d{2}\.\d{2}\.\d{4})(?:\s+(\d{2}:\d{2}))?\s+(.+)/,
  );
  if (!parts) {
    bot.sendMessage(
      msg.chat.id,
      "❌ Формат: /add ДД.ММ.ГГГГ [ЧЧ:ММ] текст\nПример: /add 31.12.2025 23:59 Праздник",
    );
    return;
  }
  const dateStr = parts[1];
  let timeStr = parts[2] || null;
  const messageText = parts[3];
  if (timeStr) {
    const success = await createReminder(
      msg.chat.id,
      dateStr,
      timeStr,
      messageText,
    );
    if (success)
      bot.sendMessage(
        msg.chat.id,
        `✅ Добавлено: ${dateStr} ${timeStr} - ${messageText}`,
      );
    else bot.sendMessage(msg.chat.id, `❌ Время уже прошло`);
  } else {
    const created = await createDefaultReminders(
      msg.chat.id,
      dateStr,
      messageText,
    );
    if (created > 0)
      bot.sendMessage(
        msg.chat.id,
        `✅ Добавлены напоминания на ${dateStr} в 8:00 и 15:00`,
      );
    else bot.sendMessage(msg.chat.id, `❌ Дата уже прошла`);
  }
});

// ========== ЗАПУСК ==========
async function start() {
  await initDatabase();
  console.log("🤖 Bot ready (improved version)");
  await cleanExpiredReminders();
  await checkReminders();
}
start().catch(console.error);
