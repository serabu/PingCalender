"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkReminders = checkReminders;
exports.startScheduler = startScheduler;
const database_1 = require("./database");
let isChecking = false;
async function checkReminders(bot) {
    if (isChecking)
        return;
    isChecking = true;
    try {
        const reminders = await (0, database_1.getPendingReminders)();
        for (const reminder of reminders) {
            try {
                await bot.sendMessage(reminder.chat_id, `🔔 *НАПОМИНАНИЕ!*\n📅 ${reminder.date} в ${reminder.time}\n📝 ${reminder.message}`, { parse_mode: 'Markdown' });
                await (0, database_1.removeSentReminder)(reminder.id);
                console.log(`✅ Sent reminder ${reminder.id} to ${reminder.chat_id}`);
            }
            catch (error) {
                console.error(`Failed to send reminder ${reminder.id}:`, error);
            }
        }
    }
    catch (error) {
        console.error('Error checking reminders:', error);
    }
    finally {
        isChecking = false;
    }
}
function startScheduler(bot) {
    // Проверяем каждую минуту
    setInterval(() => checkReminders(bot), 60 * 1000);
    // Первая проверка сразу после запуска
    checkReminders(bot);
    console.log('⏰ Scheduler started (checking every minute)');
}
