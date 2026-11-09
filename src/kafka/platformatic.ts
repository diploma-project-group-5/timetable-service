// Адаптер Kafka на @platformatic/kafka (чистий JS, підтримує Kafka 3.5–4.x; kafkajs не
// оновлюється з 2023 року). Продюсер ідемпотентний з acks=all; консюмер без автокоміту:
// offset підтверджує processMessage після обробки або запису в DLQ.
import {
  Consumer,
  Producer as KafkaProducer,
  ProduceAcks,
  stringDeserializers,
  stringSerializers,
  type MessagesStream,
} from '@platformatic/kafka';
import type { IncomingMessage, MessageSource, OutgoingMessage, Producer } from './bus.js';

export function createProducer(opts: { brokers: string[]; clientId: string }): Producer {
  const producer = new KafkaProducer({
    clientId: opts.clientId,
    bootstrapBrokers: opts.brokers,
    serializers: stringSerializers,
    idempotent: true,
    acks: ProduceAcks.ALL,
    // Топіки створює лише kafka-init (auto.create.topics.enable=false).
    autocreateTopics: false,
  });
  return {
    async send(messages: OutgoingMessage[]) {
      if (messages.length === 0) return;
      await producer.send({
        messages: messages.map((m) => ({ topic: m.topic, key: m.key, value: m.value, ...(m.headers ? { headers: m.headers } : {}) })),
      });
    },
    close: () => producer.close(),
  };
}

export function createSource(opts: { brokers: string[]; clientId: string; groupId: string; topics: string[] }): MessageSource {
  const consumer = new Consumer({
    clientId: opts.clientId,
    groupId: opts.groupId,
    bootstrapBrokers: opts.brokers,
    deserializers: stringDeserializers,
    autocommit: false,
  });
  let stream: MessagesStream<string, string, string, string> | undefined;
  return {
    async run(onMessage) {
      stream = await consumer.consume({
        topics: opts.topics,
        autocommit: false,
        // Спершу підтверджені offset групи; для нової групи — з початку топіка (події не губляться).
        mode: 'committed',
        fallbackMode: 'earliest',
        sessionTimeout: 30_000,
        heartbeatInterval: 3_000,
      });
      for await (const m of stream) {
        const message: IncomingMessage = {
          topic: m.topic,
          partition: m.partition,
          offset: String(m.offset),
          key: m.key ?? null,
          value: m.value ?? '',
          commit: async () => {
            await m.commit();
          },
        };
        await onMessage(message);
      }
    },
    async close() {
      if (stream) await stream.close();
      await consumer.close(true);
    },
  };
}
