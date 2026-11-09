// Межа між сервісом і Kafka. Логіка relay і консюмера працює з цими інтерфейсами, тож у тестах
// їх підміняє шина в пам'яті, а в проді — адаптер @platformatic/kafka (platformatic.ts).

export interface OutgoingMessage {
  topic: string;
  /** Ключ партиції — завжди school_id (розділ 12). */
  key: string;
  value: string;
  headers?: Record<string, string>;
}

export interface Producer {
  /** Підтверджує запис усіх повідомлень (acks=all) або кидає виняток. */
  send(messages: OutgoingMessage[]): Promise<void>;
  close(): Promise<void>;
}

export interface IncomingMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string;
  /** Підтверджує offset цього повідомлення в групі споживачів. */
  commit(): Promise<void>;
}

export interface MessageSource {
  /** Віддає повідомлення по одному; наступне — лише після завершення обробника. */
  run(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export const dlqTopic = (topic: string) => `${topic}.dlq`;
