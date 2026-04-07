import TelegramBot from 'node-telegram-bot-api';
import { addReminder, getReminders, deleteReminder } from './database';

export function setupHandlers(bot: TelegramBot) {
  
  bot.onText(/\/start/, (msg) => {
    const welcomeMessage = `
📅 *PingCalendar Bot - Ваш личный календарь*

*Доступные команды:*
/add ДД.ММ.ГГГГ ЧЧ:ММ Текст - Добавить напоминание
/list - Показать все напоминания
/delete ID - Удалить напоминание

*Пример:*
\`/add 31.12.2024 23:59 Встретить Новый год\`

*Время указывайте в московском времени (МСК)*
    `;
    bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match![1];
    
    const dateRegex = /(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(.+)/;
    const parsed = input.match(dateRegex);
    
    if (!parsed) {
      bot.sendMessage(chatId, '❌ Неверный формат!\nИспользуйте: `/add ДД.ММ.ГГГГ ЧЧ:ММ Текст`', { parse_mode: 'Markdown' });
      return;
    }
    
    const [_, date, time, message] = parsed;
    const [day, month, year] = date.split('.');
    const [hours, minutes] = time.split(':');
    
    const notifyAt = new Date(parseInt(year), parseInt(month)-1, parseInt(day), parseInt(hours), parseInt(minutes)).getTime();
    
    if (isNaN(notifyAt)) {
      bot.sendMessage(chatId, '❌ Неверная дата!');
      return;
    }
    
    if (notifyAt < Date.now()) {
      bot.sendMessage(chatId, '❌ Дата и время уже прошли!');
      return;
    }
    
    try {
      const id = await addReminder(chatId, date, time, message, notifyAt);
      bot.sendMessage(chatId, `✅ Напоминание добавлено (ID: ${id})\n📅 ${date} в ${time}\n📝 ${message}`);
    } catch (error) {
      console.error(error);
      bot.sendMessage(chatId, '❌ Ошибка при сохранении');
    }
  });

  bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
      const reminders = await getReminders(chatId);
      
      if (reminders.length === 0) {
        bot.sendMessage(chatId, '📭 У вас нет запланированных напоминаний');
        return;
      }
      
      let response = '📋 *Ваши напоминания:*\n\n';
      reminders.forEach((rem: any) => {
        response += `*${rem.id}.* ${rem.date} ${rem.time} - ${rem.message}\n`;
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
    const id = parseInt(match![1]);
    
    try {
      const deleted = await deleteReminder(id, chatId);
      
      if (deleted) {
        bot.sendMessage(chatId, `✅ Напоминание ${id} удалено`);
      } else {
        bot.sendMessage(chatId, `❌ Напоминание ${id} не найдено`);
      }
    } catch (error) {
      console.error(error);
      bot.sendMessage(chatId, '❌ Ошибка при удалении');
    }
  });
}