import TelegramBot from 'node-telegram-bot-api';
import { getPendingReminders, removeSentReminder } from './database';

let isChecking = false;

export async function checkReminders(bot: TelegramBot) {
  if (isChecking) return;
  isChecking = true;
  
  try {
    const reminders = await getPendingReminders();
    
    for (const reminder of reminders) {
      try {
        await bot.sendMessage(
          reminder.chat_id,
          `🔔 *НАПОМИНАНИЕ!*\n📅 ${reminder.date} в ${reminder.time}\n📝 ${reminder.message}`,
          { parse_mode: 'Markdown' }
        );
        await removeSentReminder(reminder.id);
        console.log(`✅ Sent reminder ${reminder.id} to ${reminder.chat_id}`);
      } catch (error) {
        console.error(`Failed to send reminder ${reminder.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Error checking reminders:', error);
  } finally {
    isChecking = false;
  }
}

export function startScheduler(bot: TelegramBot) {
  // Проверяем каждую минуту
  setInterval(() => checkReminders(bot), 60 * 1000);
  
  // Первая проверка сразу после запуска
  checkReminders(bot);
  
  console.log('⏰ Scheduler started (checking every minute)');
}