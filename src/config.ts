// Конфігурація зі змінних середовища. Обов'язкові змінні перевіряються при старті:
// сервіс не запускається з неповним .env і називає, чого бракує.

/** Пріоритетні для очного навчання освітні галузі за рекомендацією МОН (розділ 04). */
export const DEFAULT_PRIORITY_AREAS = ['math', 'science', 'language_literature', 'civic_history'];

export interface Policy {
  /** Ліміт часу побудови для solver, с (contracts: solver обрізає до [10, 180]). */
  buildTimeLimitS: number;
  substitutionTimeLimitS: number;
  /** Строк черги: queue_deadline_at = створення + це значення (contracts: ≥ 10 хв). */
  queueAllowanceS: number;
  /** Запас: run_deadline_at = started_at + ліміт часу + запас (contracts: ≥ 90 с). */
  runDeadlineMarginS: number;
  /** effective_from не раніше ніж через N днів (розділ 05; «7» — рішення команди). */
  publishMinDays: number;
  /** Рекомендація розкладу тривог: понад N хвилин тривог за день, M днів поспіль. */
  alertThresholdMinutes: number;
  alertThresholdDays: number;
  priorityAreas: string[];
}

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  relayDatabaseUrl: string;
  maintDatabaseUrl: string;
  oidcIssuer: string;
  oidcJwksUrl: string;
  oidcClientId: string;
  /** school-service внутрішньою мережею: http://school-service:3102 (у dev — http://localhost:3102). */
  schoolInternalUrl: string;
  /** Секрет HMAC для QR (розділ 11): лише в .env, не в git; мінімум 32 символи. */
  qrSecret: string;
  /** Публічна адреса для посилань QR: https://<домен> (як LAD_PUBLIC_URL у platform). */
  publicUrl: string;
  kafkaBrokers: string[];
  kafkaClientId: string;
  kafkaGroupId: string;
  relayIntervalMs: number;
  policy: Policy;
}

export const DEFAULT_POLICY: Policy = {
  buildTimeLimitS: 60,
  substitutionTimeLimitS: 30,
  queueAllowanceS: 600,
  runDeadlineMarginS: 90,
  publishMinDays: 7,
  alertThresholdMinutes: 120,
  alertThresholdDays: 3,
  priorityAreas: DEFAULT_PRIORITY_AREAS,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };
  const int = (name: string, fallback: number, min = 1): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} має бути цілим числом ≥ ${min}, отримано: ${raw}`);
    return n;
  };
  const list = (name: string, fallback: string[]) =>
    env[name] === undefined
      ? fallback
      : env[name]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  const config: Config = {
    host: env.HOST ?? '0.0.0.0',
    port: int('PORT', 3003),
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required('DATABASE_URL'),
    relayDatabaseUrl: required('RELAY_DATABASE_URL'),
    maintDatabaseUrl: required('MAINT_DATABASE_URL'),
    oidcIssuer: required('OIDC_ISSUER'),
    oidcJwksUrl: required('OIDC_JWKS_URL'),
    oidcClientId: env.OIDC_CLIENT_ID ?? 'web',
    schoolInternalUrl: required('SCHOOL_INTERNAL_URL').replace(/\/+$/, ''),
    qrSecret: required('QR_HMAC_SECRET'),
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost').replace(/\/+$/, ''),
    kafkaBrokers: list('KAFKA_BROKERS', []),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? 'timetable-service',
    kafkaGroupId: env.KAFKA_GROUP_ID ?? 'timetable-service',
    relayIntervalMs: int('RELAY_INTERVAL_MS', 500),
    policy: {
      buildTimeLimitS: int('BUILD_TIME_LIMIT_S', DEFAULT_POLICY.buildTimeLimitS, 10),
      substitutionTimeLimitS: int('SUBSTITUTION_TIME_LIMIT_S', DEFAULT_POLICY.substitutionTimeLimitS, 10),
      queueAllowanceS: int('QUEUE_ALLOWANCE_S', DEFAULT_POLICY.queueAllowanceS, 600),
      runDeadlineMarginS: int('RUN_DEADLINE_MARGIN_S', DEFAULT_POLICY.runDeadlineMarginS, 90),
      publishMinDays: int('PUBLISH_MIN_DAYS', DEFAULT_POLICY.publishMinDays, 0),
      alertThresholdMinutes: int('ALERT_THRESHOLD_MINUTES', DEFAULT_POLICY.alertThresholdMinutes),
      alertThresholdDays: int('ALERT_THRESHOLD_DAYS', DEFAULT_POLICY.alertThresholdDays),
      priorityAreas: list('PRIORITY_AREAS', DEFAULT_POLICY.priorityAreas),
    },
  };

  if (missing.length > 0) {
    throw new Error(`Не задано змінні середовища: ${missing.join(', ')} (див. .env.example)`);
  }
  if (config.qrSecret.length < 32) {
    throw new Error('QR_HMAC_SECRET має містити щонайменше 32 символи');
  }
  return config;
}
