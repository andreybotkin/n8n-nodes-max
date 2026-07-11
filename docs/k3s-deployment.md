# Развёртывание в n8n на k3s

Проект разворачивается как собственный immutable-образ n8n. Нода находится в `/opt/n8n-custom`, поэтому существующий PVC `/home/node/.n8n` не перекрывает её при монтировании.

## 1. Узнать текущую версию n8n

Нельзя собирать образ от `latest`: версия основы должна совпадать с работающей в кластере.

```bash
kubectl -n dataflow get pods \
  -l app.kubernetes.io/instance=n8n \
  -o jsonpath='{.items[0].spec.containers[0].image}{"\n"}'
```

Пример результата:

```text
n8nio/n8n:2.29.9
```

## 2. Собрать образ через GitHub Actions

1. Откройте **Actions → Build n8n image with MAX node → Run workflow**.
2. Введите точный тег n8n, например `2.29.9`.
3. Workflow опубликует два тега:

```text
ghcr.io/andreybotkin/mzot-n8n-max:<n8n-version>-<commit-sha>
ghcr.io/andreybotkin/mzot-n8n-max:<n8n-version>-latest
```

Для production используйте тег с полным commit SHA, а не `latest`.

Локальная сборка эквивалентна:

```bash
N8N_VERSION=2.29.9
IMAGE=ghcr.io/andreybotkin/mzot-n8n-max:${N8N_VERSION}-$(git rev-parse HEAD)

docker buildx build \
  --platform linux/amd64 \
  --build-arg N8N_VERSION="$N8N_VERSION" \
  -f Dockerfile.n8n \
  -t "$IMAGE" \
  --push \
  .
```

## 3. Доступ k3s к приватному GHCR

Если GHCR package приватный, создайте token с правом `read:packages` и Kubernetes secret:

```bash
kubectl -n dataflow create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=andreybotkin \
  --docker-password="$GHCR_TOKEN"
```

## 4. Изменить `n8n-helm.yaml`

Замените верхнеуровневый блок `image`:

```yaml
image:
  repository: ghcr.io/andreybotkin/mzot-n8n-max
  pullPolicy: IfNotPresent
  tag: "<n8n-version>-<full-commit-sha>"

imagePullSecrets:
  - name: ghcr-pull
```

Добавьте в существующий `main.extraEnvVars`:

```yaml
main:
  extraEnvVars:
    WEBHOOK_URL: "https://n8n.almostmind.com/"
    N8N_EDITOR_BASE_URL: "https://n8n.almostmind.com/"
    N8N_HOST: "n8n.almostmind.com"
    N8N_PROTOCOL: "https"
    N8N_LISTEN_ADDRESS: "0.0.0.0"
    N8N_PROXY_HOPS: "1"
    N8N_CUSTOM_EXTENSIONS: "/opt/n8n-custom/node_modules/n8n-nodes-max/dist"
```

`N8N_CUSTOM_EXTENSIONS` уже записан в образ, но его явное указание в Helm values делает конфигурацию видимой и упрощает диагностику.

При `worker.mode: regular` отдельные worker и webhook pods не запускаются: ноду загружает main pod. Если позднее режим будет переключён на `queue`, тот же custom image и `N8N_CUSTOM_EXTENSIONS` должны использовать main, worker и webhook pods.

## 5. Обновить Helm release

```bash
helm repo update

helm upgrade n8n community-charts/n8n \
  --namespace dataflow \
  -f ./config/dataflow/n8n-helm.yaml

kubectl -n dataflow rollout status deployment/n8n-main
```

Если имя Deployment отличается:

```bash
kubectl -n dataflow get deployments \
  -l app.kubernetes.io/instance=n8n
```

## 6. Проверить загрузку ноды

```bash
POD=$(kubectl -n dataflow get pods \
  -l app.kubernetes.io/instance=n8n \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n dataflow exec "$POD" -- \
  node -p "require('/opt/n8n-custom/node_modules/n8n-nodes-max/package.json').version"

kubectl -n dataflow exec "$POD" -- \
  ls -la /opt/n8n-custom/node_modules/n8n-nodes-max/dist/nodes/Max
```

В каталоге должны присутствовать `SecureMax.node.js` и `SecureMaxTrigger.node.js`. После этого в редакторе n8n появятся `Max` и `Max Trigger`.

## 7. Настроить MAX Trigger

1. Создайте Max credentials с access token бота.
2. Добавьте `Max Trigger`.
3. Задайте Webhook Secret из разрешённых символов `A-Z`, `a-z`, `0-9`, `_`, `-`, длиной 5-256 символов.
4. Активируйте workflow.
5. После смены secret, списка events или API version деактивируйте и снова активируйте workflow. Нода удалит старую подписку и создаст новую.

Сгенерировать безопасный secret:

```bash
openssl rand -hex 32
```

## Откат

Верните предыдущий immutable image tag и выполните Helm upgrade:

```bash
helm upgrade n8n community-charts/n8n \
  --namespace dataflow \
  -f ./config/dataflow/n8n-helm.yaml
```

Данные n8n, credentials и binary files останутся на существующем PVC `n8n-pvc`.
