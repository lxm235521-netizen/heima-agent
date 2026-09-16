# 调用 h3-prompt-writing

对外接口是标准 OpenAI 协议，**任何 OpenAI SDK / Postman / NewAPI 都能直接调**。

## 准备两个值

| 变量 | 取哪来 |
|---|---|
| `baseUrl` | 本机 `http://127.0.0.1:8787`；服务器换成 `http://<公网IP>:8787` 或 `https://你的域名` |
| `apiKey` | `.env` / `.env.local` 里的 **`H3_SERVER_API_KEY`**（不是上游那个 Key） |

> 端点是 `{baseUrl}/v1/chat/completions`。注意 `/v1` 不能漏。

---

## curl（可直接粘进 Postman 的 Import → Raw text）

### 1. 基础：纯文本改写

```bash
curl --location 'http://127.0.0.1:8787/v1/chat/completions' \
--header 'Authorization: Bearer sk-把你的入站Key填到这里' \
--header 'Content-Type: application/json' \
--data '{
  "model": "h3-prompt-writing",
  "messages": [
    { "role": "user", "content": "深夜的旧仓库。老陈推开锈迹斑斑的铁门，手电光柱扫过满地纸箱。他身后跟着十七岁的小满。\n\n老陈压低声音：东西还在。\n小满紧张地咽了口唾沫：爸，外面有人。" }
  ]
}'
```

返回内容 = **提示词正文** + 一段 HTML 注释形式的元信息尾部（模式、时长、校验情况）。台词会原样保留在 `<d>[Chinese] ...</d>` 里。

### 2. 带图片（多模态，标准 OpenAI 写法）

```bash
curl --location 'http://127.0.0.1:8787/v1/chat/completions' \
--header 'Authorization: Bearer sk-把你的入站Key填到这里' \
--header 'Content-Type: application/json' \
--data '{
  "model": "h3-prompt-writing",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "把这张图作为目标视频的首帧，改写：老陈推开仓库铁门，压低声音说：东西还在。" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,你的base64" } }
      ]
    }
  ]
}'
```

`image_url.url` 支持两种：

- `data:image/png;base64,...`（内联，最多 9 张，单张 ≤ 8MB）
- 可公开访问的 `https://...` 图片地址

服务端会按真实字节嗅探格式并读出分辨率，不信任声明的 MIME。

### 3. 流式

```bash
curl --location 'http://127.0.0.1:8787/v1/chat/completions' \
--header 'Authorization: Bearer sk-把你的入站Key填到这里' \
--header 'Content-Type: application/json' \
--data '{
  "model": "h3-prompt-writing",
  "stream": true,
  "messages": [{ "role": "user", "content": "面包店开门，老陈把第一炉面包放上木柜台。" }]
}'
```

### 4. 强制模式（可选）

图是「首帧」还是「仅形象参考」决定用哪套官方规范，自动判定可能猜错。两种指定方式：

```bash
# 方式一：system 消息
--data '{
  "model": "h3-prompt-writing",
  "messages": [
    { "role": "system", "content": "Always use Ref2VA." },
    { "role": "user", "content": "参考这张图的形象改写：老陈在仓库里打开手电。" }
  ]
}'

# 方式二：文本内联标记（mode:Ref2VA / 模式=FL2VA / --mode I2VA）
--data '{
  "model": "h3-prompt-writing",
  "messages": [{ "role": "user", "content": "mode:Ref2VA 参考这个人的形象改写：老陈在仓库里打开手电。" }]
}'
```

可选值：`T2VA`（纯文本）、`I2VA`（首帧）、`FL2VA`（首尾帧）、`L2VA`（尾帧）、`Ref2VA`（全参考六段式）。

### 5. 要结构化 JSON

在消息里加一句「返回 json 格式」：

```bash
--data '{
  "model": "h3-prompt-writing",
  "messages": [{ "role": "user", "content": "深夜的旧仓库。老陈推开门。请返回 json 格式。" }]
}'
```

返回：

```json
{
  "mode": "T2VA",
  "duration_sec": 10,
  "ratio": "16:9",
  "shot_count": 2,
  "prompt": "integrated_multimodal_description: [Shot 1] ...",
  "notes_zh": "……",
  "validation": { "errors": [], "warnings": [], "stats": { } }
}
```

### 6. 模型列表 / 健康检查

```bash
curl --location 'http://127.0.0.1:8787/v1/models' \
--header 'Authorization: Bearer sk-把你的入站Key填到这里'

curl --location 'http://127.0.0.1:8787/api/health'   # 无需鉴权，供健康检查用
```

### 7. 图像生成节点形态

便于接进已有的出图工作流（返回的是**提示词文本**的 base64，不是真实图片）：

```bash
curl --location 'http://127.0.0.1:8787/v1/images/generations' \
--header 'Authorization: Bearer sk-把你的入站Key填到这里' \
--header 'Content-Type: application/json' \
--data '{ "model": "h3-prompt-writing", "prompt": "深夜的旧仓库，老陈推开锈迹斑斑的铁门。", "size": "1024x1024" }'
```

---

## Postman 集合

导入 `postman/H3-分镜提示词智能体.postman_collection.json`（Import → File），里面已内置 7 个可直接发送的请求。

导入后在**集合变量**里改两个值即可：

| 变量 | 改成 |
|---|---|
| `baseUrl` | `http://127.0.0.1:8787` 或你的服务器地址 |
| `apiKey` | 你的 `H3_SERVER_API_KEY` |

集合还内置了一个 `imageDataUrl` 变量（一张 512×288 的示例图），所以「带图片」那条**开箱即可发送**，不需要你准备图。

---

## 常见错误对照

| 现象 | 原因 |
|---|---|
| `401 invalid_api_key` | `apiKey` 填错，或填成了**上游**的 Key。要填 `H3_SERVER_API_KEY` |
| `404` | 路径缺 `/v1`，或渠道类型配成了 Claude / Gemini 原生协议（本服务只实现 OpenAI 协议） |
| `503 login_not_configured` | 这是网页控制台的问题，与 `/v1` 无关；`/v1` 只需要 API Key |
| `502 upstream_error` | 上游模型/中转站的问题，不是本服务。上游偶发 500 时重试即可 |
| 图片被忽略 | 上游模型不支持图片输入。换成支持视觉的模型 |
| 生成很慢（15–35 秒） | 正常。要跑两次模型调用（规划 + 生成）；勾选「深度模式」可减到一次 |

## 关于鉴权的两点说明

- **`/v1/*` 只需要 API Key**，与网页登录完全独立、互不通用。网页登录不能用来调 `/v1`，API Key 也不能读改配置。
- **公网部署务必套 TLS**（Caddy/Nginx）。HTTP 明文下 API Key 会在网络上裸奔。
