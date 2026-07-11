# Развёртывание n8n с предустановленной Max node в Kubernetes

Репозиторий содержит `Dockerfile.n8n`, который собирает образ n8n с уже установленной community node `n8n-nodes-max`.

Нода размещается в `/opt/n8n-custom`, поэтому стандартный volume `/home/node/.n8n` не перекрывает её при монтировании.

## 1. Выбрать версию n8n

Рекомендуется использовать точный тег n8n, а не `latest`.

Узнать образ работающего pod можно командой:

```bash
kubectl -n <namespace> get pods \
  -l app.kubernetes.io/instance=<release-name> \
  -o jsonpath='{.items[0].spec.containers[0].image}{"\n"}'
```

Пример:

```text
n8nio/n8n:2.29.9
```

## 2. Использовать готовый образ

Образы публикуются в GitHub Container Registry:

```text
ghcr.io/andreybotkin/n8n-with-max:<n8n-version>-<commit-sha>
ghcr.io/andreybotkin/n8n-with-max:<n8n-version>-latest
```

Для production рекомендуется использовать immutable-тег с commit SHA.

```bash
docker pull ghcr.io/andreybotkin/n8n-with-max:<n8n-version>-<commit-sha>
```

## 3. Собрать образ самостоятельно

В GitHub Actions доступен ручной workflow **Build n8n image with MAX node**. При запуске нужно указать точный тег базового образа n8n.

Локальная сборка:

```bash
N8N_VERSION=2.29.9
IMAGE=ghcr.io/<owner>/n8n-with-max:${N8N_VERSION}-$(git rev-parse HEAD)

docker buildx build \
  --platform linux/amd64 \
  --build-arg N8N_VERSION="$N8N_VERSION" \
  -f Dockerfile.n8n \
  -t "$IMAGE" \
  --push \
  .
```

## 4. Настроить Helm values

Для `community-charts/n8n` замените образ:

```yaml
image:
  repository: ghcr.io/andreybotkin/n8n-with-max
  pullPolicy: IfNotPresent
  tag: "<n8n-version>-<commit-sha>"
```

Путь к custom node уже задан внутри образа:

```text
/opt/n8n-custom/node_modules/n8n-nodes-max/dist
```

При необходимости его можно явно указать в Helm values:

```yaml
main:
  extraEnvVars:
    N8N_CUSTOM_EXTENSIONS: "/opt/n8n-custom/node_modules/n8n-nodes-max/dist"
```

Если образ приватный, добавьте Kubernetes image pull secret:

```bash
kubectl -n <namespace> create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password="$GHCR_TOKEN"
```

И укажите его в values:

```yaml
imagePullSecrets:
  - name: ghcr-pull
```

## 5. Обновить Helm release

```bash
helm repo update

helm upgrade <release-name> community-charts/n8n \
  --namespace <namespace> \
  -f values.yaml
```

Проверить rollout:

```bash
kubectl -n <namespace> get deployments \
  -l app.kubernetes.io/instance=<release-name>

kubectl -n <namespace> rollout status deployment/<deployment-name>
```

## 6. Проверить загрузку ноды

```bash
POD=$(kubectl -n <namespace> get pods \
  -l app.kubernetes.io/instance=<release-name> \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n <namespace> exec "$POD" -- \
  node -p "require('/opt/n8n-custom/node_modules/n8n-nodes-max/package.json').version"

kubectl -n <namespace> exec "$POD" -- \
  ls -la /opt/n8n-custom/node_modules/n8n-nodes-max/dist/nodes/Max
```

В каталоге должны присутствовать:

```text
SecureMax.node.js
SecureMaxTrigger.node.js
```

После перезапуска в редакторе n8n должны появиться `Max` и `Max Trigger`.

## 7. Настроить Max Trigger

1. Создайте credentials `Max API`.
2. Укажите access token бота и `Webhook Secret` длиной 5-256 символов. Разрешены латинские буквы, цифры, `_` и `-`.
3. Добавьте `Max Trigger` и выберите созданные credentials.
4. Активируйте workflow.

Сгенерировать secret:

```bash
openssl rand -hex 32
```

Секрет сохраняется в credentials n8n и повторно вводить его в `Max Trigger` не требуется. После изменения secret, списка events, API version или внешнего webhook URL деактивируйте и снова активируйте workflow. Нода заменит существующую подписку.

## Queue mode

Если n8n работает в queue mode, один и тот же образ должен использоваться main, worker и webhook pods. У всех экземпляров также должен быть одинаковый `N8N_ENCRYPTION_KEY`.

## Откат

Верните предыдущий immutable image tag и повторите `helm upgrade`. Данные n8n сохранятся в используемых PostgreSQL и persistent volumes.
