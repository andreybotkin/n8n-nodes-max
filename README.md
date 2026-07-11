# n8n-nodes-max

Нода для интеграции мессенджера MAX с n8n: исходящие сообщения, вложения, inline-кнопки и webhook trigger.

Этот fork содержит дополнительные исправления безопасности для MZOT. Пакет `n8n-nodes-max` из публичного npm registry может содержать upstream-версию без этих исправлений, поэтому для k3s используйте custom n8n image из этого репозитория.

## Установка

### k3s + community-charts/n8n

Рекомендуемый способ — собрать immutable-образ n8n с нодой внутри:

```bash
docker buildx build \
  --platform linux/amd64 \
  --build-arg N8N_VERSION=<точный-тег-n8n> \
  -f Dockerfile.n8n \
  -t ghcr.io/andreybotkin/mzot-n8n-max:<тег> \
  --push \
  .
```

После этого укажите образ в Helm values:

```yaml
image:
  repository: ghcr.io/andreybotkin/mzot-n8n-max
  pullPolicy: IfNotPresent
  tag: "<тег>"

main:
  extraEnvVars:
    N8N_CUSTOM_EXTENSIONS: "/opt/n8n-custom/node_modules/n8n-nodes-max/dist"
```

Полная инструкция для MZOT: [`docs/k3s-deployment.md`](docs/k3s-deployment.md).

### Локальная разработка

```bash
npm ci --ignore-scripts
npm run build
npm link
npm install --prefix ~/.n8n/custom file:$(pwd)
n8n start
```

`N8N_CUSTOM_EXTENSIONS` принимает путь к каталогу custom nodes, а не имя npm-пакета.

## Возможности

### Сообщения

- Отправка текстовых сообщений с форматированием.
- Автоматический fallback в plain text при ошибке MAX API о неподдерживаемом Markdown.
- Редактирование и удаление сообщений.
- `Disable Link Preview` и очистка текущих вложений при редактировании.
- Отправка изображений, видео, аудио и документов через Binary Data.
- Повторное использование готового MAX attachment token без новой загрузки.
- Несколько вложений в одном сообщении.
- Reply и forward.
- Автоматический retry при временной ошибке обработки media attachment.
- Inline-клавиатуры и callback.

Загрузка вложений по произвольному URL отключена: это предотвращает SSRF, запросы к внутренним сервисам и неконтролируемую загрузку больших файлов в память.

### Чаты

- Получение информации о чате.
- Выход из группового чата.

### Trigger

- `message_created` и `message_chat_created`.
- Callback кнопок.
- События пользователей, чатов и бота.
- Поддержка IDN/Punycode webhook URL.
- Обязательная проверка `X-Max-Bot-Api-Secret`.
- Fail-closed фильтры chat/user ID.
- Автоматическое пересоздание подписки при смене secret, events, API version или webhook URL.

## Безопасность

- MAX API закреплён на `https://platform-api2.max.ru`.
- Credentials содержат только access token; Base URL нельзя заменить через UI.
- Bot token не отправляется на multipart upload endpoint.
- Multipart upload разрешён только на документированных HTTPS-хостах MAX и не следует redirects.
- Webhook Secret должен содержать 5-256 символов из `A-Z`, `a-z`, `0-9`, `_`, `-`.
- URL attachments отсутствуют в UI и дополнительно блокируются во время выполнения.

## Настройка

1. Создайте бота через MAX для бизнеса.
2. Получите access token.
3. Создайте в n8n credentials `Max API`.
4. Для входящих событий добавьте `Max Trigger`, выберите events и задайте Webhook Secret.
5. Активируйте workflow.

Сгенерировать secret:

```bash
openssl rand -hex 32
```

После изменения secret, events или API version деактивируйте и снова активируйте workflow. Нода заменит старую MAX subscription.

## Проверки

```bash
npm ci --ignore-scripts
npm run lint
npm test -- --runInBand
npm run build
```

## Ресурсы

- [Документация MAX Bot API](https://dev.max.ru/docs-api)
- [Репозиторий fork](https://github.com/andreybotkin/n8n-nodes-max)
- [Upstream](https://github.com/pfrankov/n8n-nodes-max)

## Лицензия

[MIT](LICENSE.md)
