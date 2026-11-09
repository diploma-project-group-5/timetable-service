# timetable-service

Задачі побудови, версії розкладу, публікація, розклад тривог, заміни, QR і публічні сторінки «Лад» (специфікація, розділи 03–07, 10–12). Сервіс сам не рахує: веде задачі для `solver`, перевіряє кожен результат `validator-lib` синхронно, у процесі, і рахує сторінки за QR при читанні (`resolveScheduleAt`).

Node 24 · TypeScript 6.0 · Fastify 5 · Kysely + PostgreSQL 16 (btree_gist) · @platformatic/kafka · @lad/validator-lib · jose · Vitest 4.1 + Testcontainers.

## API кабінету `/api/v1/timetable/*`

Лише токен клієнта `web` з роллю `scheduler` і `school_id`; заклад — з токена. 401 / 403 / 404 як у school-service. Помилки — `application/problem+json` з `code`, для порушень правил — `conflicts[]` у формі `contracts/schemas/events/conflict.v1.json`. Дії — через двокрапку.

### Задачі й версії

| Маршрут | Відповідь | Що робить |
|---|---|---|
| `POST /timetables:build` | 202 `{job_id}` · 409 `build_in_progress` (+`job_id` активної) · 422 `profile_incomplete` (+`fields`) | знімок у school, задача з `snapshot_version` і `queue_deadline_at`, `solve.build.requested`; дешеві передперевірки, що не пройшли, одразу дають `infeasible` |
| `GET /jobs/{job_id}` | 200 | стан; для `infeasible`/`rejected` — `conflicts`; `result`: `{timetable_id}` / `{alert_plan: true, timetable_id}` / `{proposals}` |
| `GET /timetables` | 200 | версії `kind='main'`: `state`, `effective_from`, обчислена `phase` (`scheduled` · `current` · `archived`), `data_changed_since_build` |
| `GET /timetables/{id}` | 200 | сітка: `lessons`, `day_formats` (`format`: `in_person` / `remote`), копії `classes`, `teachers`, `subjects`, `order` |
| `GET /timetables/{id}/load` | 200 | навантаження укриття по днях (значення рахує validator-lib), причина формату кожного класо-дня, підсумок (`peak`, `remote_class_days`, `build_ms`, `classes_without_in_person_days`), `validation`; працює і для шаблону тривог |
| `POST /timetables/{id}:publish` | 200 · 409 `stale` / `already_published` · 422 | `{order_no, order_date, approved_by, effective_from}`; навчальний день не раніше ніж через 7 днів (Europe/Kyiv); свіжий знімок — якщо `snapshot_version` змінилась, перевірка validator-lib на свіжих даних; одна запланована версія; завжди `warnings.lost_substitutions[]` |
| `POST /timetables/{id}:copy` | 201 | етап 2 · копія main у `validated` з тим самим `snapshot_version` |
| `PATCH /timetables/{id}/lessons/{classId}/{day}/{lessonNo}` | 200 · 409 `conflicts` / `published_readonly` | етап 2 · `{day, lesson_no}`; зайнятий слот класу — обмін; синхронна перевірка validator-lib |

### Розклад тривог

| Маршрут | Що робить |
|---|---|
| `GET /alert-plan` | `{timetable_id, state, bells, order, activations: [{activation_id, from, to}]}`; `to` — дата повернення (не включно) |
| `POST /alert-plan:build` | побудова за моделлю 1.2 (учні ≤ навчальних місць і всі люди ≤ паспорту; «не в укритті» → дистанційний день); 409 `alert_plan_active`, поки є чинна чи майбутня активація |
| `GET` `PUT /alert-plan/bells` | дзвінки тривог № 1..N без пропусків; PUT повертає план у draft; 409, поки є чинна чи майбутня активація |
| `POST /alert-plan:approve` | `{order_no, order_date, approved_by}`; 409 `build_in_progress` / `alert_plan_missing` |
| `POST /alert-plan:activate` | `{from}` — навчальна дата не раніше сьогодні; 409 `alert_plan_not_approved` / `stale` / `activation_overlap` / `build_in_progress`; `warnings.lost_substitutions[]` |
| `POST /alert-plan/activations/{id}:end` | `{from}` — дата повернення (пізніша за початок, не раніше сьогодні); ще не чинна активація скасовується; `warnings.lost_substitutions[]` |
| `GET /alert-hours?from=&to=` | тривалість тривог по днях, `current_streak_days`, `recommendation`, пороги `threshold_minutes`, `threshold_days` |
| `PUT /alert-hours/{date}` | `{minutes}` (0–1440) за минулий день або сьогодні |

Результат `build_alert`, що приходить, коли план уже погоджено або є активація, — задача `rejected` з `error: alert_plan_locked`.

### Відсутності, заміни, канікули, експорт (етап 2)

| Маршрут | Що робить |
|---|---|
| `POST /absences` | `{teacher_id, date_from, date_to, lesson_nos?}` → 202 `{absence_id, job_ids}`: задача `substitution` на кожну навчальну дату з уроками; дати активації — від шаблону тривог; причини немає |
| `GET /absences`, `DELETE /absences/{id}` | поточні й майбутні відсутності зі станом задач; скасування робить пропозиції й погоджені накладки `rejected` |
| `GET /substitutions?date=` | накладки на дату: `kind` (`teacher` · `moved` · `self_study` · `cancelled`), `new_teacher_id`, `off_profile`, `moved_to`, `step`, `state` |
| `POST /substitutions/{job_id}:approve` | `{cancel?: [{class_id, lesson_no}]}` — «самостійна робота» → «скасовано»; SELECT … FOR UPDATE закладу; 409 `stale` (на дату діє інша версія) / `conflicts` / `slot_taken` |
| `POST /substitutions/{job_id}:reject` | пропозиції → `rejected` (зберігаються для RQ4) |
| `GET` `PUT /holidays` | `{holiday_from, holiday_to}`: дві дати або обидві `null`; вільного тексту немає |
| `GET /teachers/{id}/export` | частина експорту (ст. 8): уроки у версіях, відсутності, заміни |

### QR

| Маршрут | Що робить |
|---|---|
| `GET /access-tokens?type=class\|teacher` | відтворені посилання QR активних класів чи вчителів: `{token_id, scope, target_id, target_label, generation, url}`; `no-store` |
| `POST /access-tokens/{id}:rotate` | `generation + 1`: старий QR одразу недійсний, інші не змінюються |

## Публічний доступ `/api/v1/public/timetable`

Без JWT, токен лише в заголовку `X-Access-Token` (у посиланні він у фрагменті `#`). Токен — `school_id.token_id.MAC`, `MAC = base64url(HMAC-SHA256(secret, school_id ‖ scope ‖ token_id ‖ generation))` (uuid по 16 байт, scope 1 байт, generation int32 BE), порівняння через `crypto.timingSafeEqual`. Невідомий, відкликаний чи підроблений токен — однакова 404 «Посилання недійсне. Зверніться до закладу».

Відповідь — поточний і наступний ISO-тиждень за Europe/Kyiv: `{state, target_label, published_at, upcoming_change, weeks: [{week, days: [{date, format, lessons, holiday?}]}]}`. Сторінка класу показує предмети й позначку заміни, без підписів вчителів; сторінка вчителя — класи, зокрема уроки, де він новий вчитель у погодженій заміні. Ніде немає назви закладу, кількості учнів і місткості. Заголовки: `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`. Rate limit — у шлюзі.

## Події

| Топік | Напрям | Що |
|---|---|---|
| `solve.build.requested` | публікує | `contracts/schemas/events/solve.build.requested.v1.json` (тест перевіряє подію схемою); лише id, без назв і підписів |
| `solve.substitution.requested` | публікує | чернетка contracts для етапу 2 |
| `audit.recorded` | публікує | `{at, actor, action, target, details}` — публікація, погодження/активація/повернення розкладу тривог, відсутності й заміни, перевипуск QR, канікули, експорт |
| `solve.status` | слухає | `solve.started` лише з `queued`; `solve.completed` з будь-якого некінцевого стану; події для кінцевого стану й повтори `event_id` відкидаються. Перевірено на `contracts/vectors/job-lifecycle` |
| `school.data.changed` | слухає | останній відомий `snapshot_version` (ознака «дані змінилися після побудови»); новий клас чи вчитель — QR; архівований клас чи видалений вчитель — `revoked_at`; видалений вчитель — «Вчитель #N» у копіях версій; зміна дзвінків чи профілю — свіжі дзвінки для сторінок за QR |

Outbox, inbox, relay, консюмер (3 спроби → `<топік>.dlq`) — як у school-service. Сторож (роль `timetable_maint`) раз на хвилину переводить у `failed` задачі в `queued` після `queue_deadline_at` і в `running` після `run_deadline_at = started_at + ліміт + 90 с`.

### Результат заміни — пропозиція для contracts

Форма результату заміни в `solve.completed` у contracts ще не спроєктована («still to be designed»). timetable приймає:

```json
"substitution": {
  "step": 1,
  "proposals": [
    { "class_id": "…", "lesson_no": 1, "kind": "teacher", "teacher_id": "…", "off_profile": true },
    { "class_id": "…", "lesson_no": 2, "kind": "moved", "moved_to": { "date": "2026-11-20", "lesson_no": 3 } },
    { "class_id": "…", "lesson_no": 3, "kind": "self_study" }
  ]
}
```

Урок задачі без пропозиції стає `self_study`. Узгодити з власником solver і внести в contracts як MINOR.

## База даних

`school_state`, `jobs`, `timetables`, `lessons`, `day_formats`, `alert_plan`, `alert_bells`, `alert_activations`, `alert_hours`, `absences`, `substitutions`, `access_tokens`, `outbox`, `inbox` — `school_id` першим у кожному первинному ключі, `FORCE ROW LEVEL SECURITY` на кожній. Інваріанти тримає БД:

- одна побудова на заклад — частковий унікальний індекс на `jobs (school_id)` для `build_*` у `queued`/`running`;
- `kind='alert'` лише `validated`, без `effective_from` і `published_at` (CHECK) і один на заклад (частковий унікальний індекс);
- активації не перетинаються — `EXCLUDE USING gist (school_id WITH =, daterange(date_from, date_to) WITH &&)`;
- одна погоджена накладка на слот — частковий унікальний індекс `WHERE state = 'approved'`.

| Роль | Що може |
|---|---|
| `timetable_owner` | власник таблиць, міграції (створює `btree_gist` — довірене розширення, суперкористувач не потрібен) |
| `timetable_app` | DML свого закладу; outbox — лише INSERT |
| `timetable_relay` | SELECT, UPDATE outbox усіх закладів |
| `timetable_maint` | SELECT, UPDATE `jobs` (сторож); SELECT, DELETE outbox та inbox (чистка, 7 днів) |

У `platform` потрібні `service_database timetable` у `db-init/init.sh` і паролі `TIMETABLE_{OWNER,APP,RELAY,MAINT}_DB_PASSWORD`.

> **Тимчасово до `@lad/db`.** `withSchool`, outbox, inbox і relay живуть у `src/db` і `src/kafka`, як у tenant-service і school-service.

## validator-lib

Підключено git-залежністю на коміт гілки `fix/git-install-prepare` (у бібліотеці додано `prepare`, щоб npm збирав `dist/` при встановленні з git). Після мерджу й тегу — замінити на `…validator-lib.git#v0.1.0`. Режиму перевірки окремої накладки заміни у validator-lib поки немає: на `:approve` timetable перевіряє вільний слот, недоступні дні, формат дня, тижневий ліміт і місткість (`dayLoad` з validator-lib) сам.

## Розбіжності з припущеннями у `frontend/src/api/types.ts`

- `Conflict` — форма з contracts: `condition` (`seats`/`passport`), числові `value` і `limit`, а не `limit: 'seats' | 'passport'`.
- `PublicDay.format` — `null` для канікул і днів, коли розклад ще не діє.
- `POST /absences` повертає `{absence_id, job_ids}`.
- `TimetableLoad` — додатково `days[].students_in_person`, `teachers_on_site`, `ok`, `class_days[].lessons`, `summary.peaks` (по умові); `peak` — за паспортом.

## Локальна розробка

```bash
cp .env.example .env
make install
make migrate
make dev
```

Потрібні `make up` у `platform` і запущений school-service (`SCHOOL_INTERNAL_URL=http://localhost:3102`). Сервіс слухає `:3003`; шлюз веде на нього `/api/v1/timetable/*` і `/api/v1/public/*`.

## Тести

```bash
make test
```

Testcontainers піднімає PostgreSQL 16.15 і Kafka 4.3.2 (потрібен Docker); вже запущені сервери — `TEST_PG_ADMIN_URL`, `TEST_KAFKA_BROKERS`; `TEST_KAFKA=off` пропускає тест зі справжньою Kafka. school-service у тестах підміняється знімками в пам'яті, solver — жадібною заглушкою.

| Файл | Що перевіряє |
|---|---|
| `test/build.test.ts` | `:build` (подія проти схеми contracts, 409, 422, передперевірки, 503), `solve.status`, сторож, `/load`, `:publish` (7 днів, навчальний день, 409 stale, фази, заміна запланованої), `:copy`, PATCH |
| `test/alert-qr.test.ts` | розклад тривог (модель 1.2, погодження, активації, перетин, `alert_plan_locked`, stale за умовою seats), облік тривог, QR (HMAC, перевипуск, підробки), публічна сторінка (без підписів, тривоги, канікули), `school.data.changed` |
| `test/substitutions.test.ts` | відсутності, пропозиції, погодження з перевіркою накладок, сторінки за QR із замінами, `lost_substitutions`, експорт |
| `test/units.test.ts` | машина станів проти `contracts/vectors/job-lifecycle`, Europe/Kyiv (23:30/00:30, DST), токен QR, конфігурація |
| `test/db.test.ts` | RLS, права app/relay/maint, FORCE, `school_id` у ключі, CHECK/EXCLUDE, міграції up/down |
| `test/infra.test.ts` | доступ, консюмер і DLQ, relay, чистка, клієнт знімка |
| `test/kafka.test.ts` | справжня Kafka: `solve.build.requested` у топіку, `solve.status` з топіка → `done`, DLQ |

Покриття: поріг 90% рядків і функцій, 80% гілок.

## Команди

| Команда | Що робить |
|---|---|
| `make install` | залежності точно за `package-lock.json` |
| `make dev` | сервіс з перезапуском при змінах |
| `make migrate` | міграції бази timetable |
| `make test` | усі тести з покриттям |
| `make check` | lint + типи + тести, як у CI |
| `make build` | зібрати `dist/` |
| `make docker-build` | зібрати образ |
