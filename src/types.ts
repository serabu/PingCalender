export interface Reminder {
  id: number;
  chatId: number;
  date: string;
  time: string;
  message: string;
  notifyAt: Date;
}

export interface BotCommand {
  command: string;
  description: string;
}