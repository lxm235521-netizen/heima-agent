# H3 分镜提示词智能体

把**小说片段 / 分镜片段 + 参考图**，用 MiniMax H3 **官方 skill** 转成专业、可直接粘贴使用的 H3 分镜提示词。

同时提供两种身份：

- **作为一个网页工具**：浏览器里输入素材、上传图片，实时看到提示词逐步成型。
- **作为一个 OpenAI 兼容模型**：可被 NewAPI 当作渠道接入，用户在你的 NewAPI 里像调模型一样调用它。

本地或 Docker 部署，零第三方依赖（只用 Node 内置模块）。

---

## 1. 先讲清楚一件事：你不需要"实现"H3 skill

看完官方仓库后，这是最关键的认知：

H3 官方仓库 `skills/` 下有 **9 个 skill**，其中 8 个是给 MiniMax Hub 画布工作流用的（依赖 `hub_generate_video` 等私有工具），**无法移植**。真正能用的只有：

```
skills/h3-prompt-writing/
├── SKILL.md                     指令与工作流
└── references/
    ├── base-en.txt              T2VA / I2VA / FL2VA / L2VA 规范
    └── ref-en.txt               Ref2VA 全参考六段式规范
```

它的本质是**约 42 KB 的 Markdown 规范文本**，没有任何代码、没有任何外部 API 调用。所以"快速实现"的正确路径不是复刻它，而是：

1. **把官方文件原样固定进项目**（本仓库已做，并锁定了上游 commit）；
2. **写一层薄壳**：输入聚合 → 多模态模型 → 结构化输出契约 → 规范校验 → 对外暴露标准协议。

真正需要动脑的只有两个问题，本项目的设计也主要围绕它们：

| 问题 | 本项目怎么解 |
|---|---|
| 模型会写散文、会加 markdown 围栏，网页无法可靠渲染 | 叠加**严格 JSON 契约**，并用容错提取器 + 自动修复兜底 |
| 模型写了"看起来对"的提示词，但不合规范 | 用**规则校验器**按官方规范逐条检查，不通过就打回重写 |

## 2. 快速开始

### 方式 A：Docker（推荐）

```bash
cd D:\AI_API\heima-agent
copy .env.example .env      # 然后按下面说明填 .env
docker compose up -d
```

打开 `http://127.0.0.1:8788`。`.env` 最少要填这三项：

```ini
# 对外：保护 /v1/* 接口，别人拿到这个 Key 才能调用你的 agent
H3_SERVER_API_KEY=sk-换成一串随机字符
# 上游：真正的算力来自哪个 NewAPI（注意保留 /v1）
H3_UPSTREAM_BASE_URL=http://host.docker.internal:3000/v1
NEWAPI_API_KEY=sk-你在NewAPI里创建的令牌
LLM_MODEL=qwen-vl-max          # 必须是支持图片输入的模型
```

> 生成随机 Key：`node -e "console.log('sk-'+require('crypto').randomBytes(24).toString('hex'))"`

### 方式 B：直接跑 Node

```bash
cd D:\AI_API\heima-agent

# 1) 配置模型（三选一）
#    a. 原厂 Key
setx DASHSCOPE_API_KEY sk-xxxx        # 然后重开终端
#    b. NewAPI 中转
setx H3_UPSTREAM_BASE_URL http://your-newapi:3000/v1
setx NEWAPI_API_KEY sk-xxxx
#    c. 启动后在页面右上角「模型设置」里填写（会存到 config.local.json）

# 2) 启动
node src/server.mjs
```

打开 `http://127.0.0.1:8788` 即可。

> **注意**：本机 PowerShell 执行策略禁用了 `npm.ps1`，所以请直接用 `node` 命令（`npm test` 会报 `running scripts is disabled`）。
> 端口被占用时会自动向后顺延（最多 12 个），启动日志会打印实际地址。

### 没有 API Key 也能先跑通

内置了一个假的 OpenAI 兼容模型，可以离线验证整条链路：

```bash
node scripts/smoke.mjs        # 起 mock 模型 + 真服务，跑通一次完整生成
node --test test/skill.test.mjs test/unit.test.mjs test/config.test.mjs test/e2e.test.mjs test/openai.test.mjs
node scripts/check-frontend.mjs                                        # 前端流式解码器检查
```

## 3. 必须用多模态模型

**这是最容易踩的坑。** H3 的 I2VA / FL2VA / L2VA / Ref2VA 都建立在"看得到图"之上——要把图片写成 `<Picture 1>` 首帧锚点、或从参考图里提取人物服装、场景、构图、画面文字。**纯文本模型（如 DeepSeek）做不到，上传的图会被直接忽略。**

页面内置了预设，切换只改 `baseUrl` + 模型名，代码不用动：

| 预设 | baseUrl | 建议模型 |
|---|---|---|
| **NewAPI / OneAPI 中转站** | `http://your-newapi:3000/v1` | 你在中转站里有的、且支持图片的模型 |
| MiniMax 开放平台（与 H3 同厂） | `https://api.minimaxi.com/v1` | `MiniMax-M2` |
| 通义千问 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max-latest` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-32k-vision-preview` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| 自定义 | 任意 | vLLM / Ollama / One-API 等 |

支持的环境变量：`NEWAPI_API_KEY`、`MINIMAX_API_KEY`、`DASHSCOPE_API_KEY`、`ZHIPUAI_API_KEY`、`MOONSHOT_API_KEY`、`SILICONFLOW_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`，以及通用的 `H3_UPSTREAM_BASE_URL` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_PLANNER_MODEL`。

配置优先级：**页面保存的 `config.local.json` > 环境变量 > 预设默认值**。

### 用第三方 NewAPI 提供算力

这是最省事的接法，因为 [NewAPI](https://docs.newapi.pro/zh/docs/guide/feature-guide/user/api) 本身就是 OpenAI 兼容网关，本项目正好说同一种协议：

```
┌──────────────┐   OpenAI 协议    ┌──────────────┐   路由/计费   ┌──────────────┐
│ 本项目 agent │ ───────────────▶ │ 你的 NewAPI  │ ───────────▶ │ 各家真实模型 │
│ (改写提示词) │  Bearer sk-xxx   │              │              │ (必须能读图) │
└──────────────┘                  └──────────────┘              └──────────────┘
```

只要在 `.env`（或页面「模型设置」）里填：

```ini
H3_UPSTREAM_BASE_URL=http://your-newapi:3000/v1
NEWAPI_API_KEY=sk-你在NewAPI创建的令牌
LLM_MODEL=你在NewAPI里真实可用的、支持图片的模型名
```

三个常见坑：

1. **baseUrl 必须带 `/v1`。** NewAPI 自身地址是 `http://host:3000`，OpenAI 兼容路径是 `http://host:3000/v1`，填错会 404。
2. **模型名必须是 NewAPI 里已配置且支持图片的模型。** 中转站的模型名可能和原厂不同，以站内显示的为准。
3. **别用自己形成环。** 如果本项目的上游 NewAPI 又把这个 agent 作为渠道接进去，就会自己调自己。请让「上游」和「下游」用不同的 Key/模型名，或干脆用两个 NewAPI 实例。

## 4. 被 NewAPI 接入（把本 agent 当成一个模型）

本项目同时对外提供 OpenAI 兼容接口，所以可以被 NewAPI 当成一个普通渠道接进去，用户在你的 NewAPI 里就能像调模型一样调这个 agent。

```
用户 ──▶ 你的 NewAPI ──▶ 本项目 agent ──▶ 上游 NewAPI/模型
        (计费、分发)      (H3 提示词改写)
```

**NewAPI 侧配置**（渠道管理 → 添加渠道）：

| 字段 | 填什么 |
|---|---|
| 类型 | OpenAI（或"自定义渠道"，只要走 `/v1/chat/completions`） |
| Base URL | `http://heima-agent:8788/v1`（容器间用服务名；本机用 `http://host.docker.internal:8788/v1`） |
| API Key | 你设置的 `H3_SERVER_API_KEY` |
| 模型 | `h3-prompt-writing`（或你自定义的 `H3_MODEL_ID`） |

然后在 NewAPI 的**游乐场**里选这个模型，输入小说片段、上传参考图，就能拿到 H3 提示词；也可以让任何 OpenAI SDK / 聊天客户端直接调用。

**调用示例**

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer $H3_SERVER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"h3-prompt-writing","messages":[{"role":"user","content":"深夜的旧仓库，老陈推开门，压低声音：东西还在。"}]}'
```

带图片（标准 OpenAI 多模态写法）：

```json
{
  "model": "h3-prompt-writing",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "把这张图作为首帧改写" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
    ]
  }]
}
```

**返回内容**：默认返回**提示词正文**，后面跟一个 HTML 注释形式的元信息尾部。这样在 NewAPI 游乐场里读起来就是干净的提示词，复制即用，而模式、时长、校验情况也都在。想要结构化数据时，在请求里加 `请返回 json 格式`（或放在 system 消息里），就会返回完整 JSON。

> 元信息为什么放在**尾部**而不是头部：流式输出时头部要等结果出来才知道；放尾部才能让"流式"和"非流式"返回**完全一致**的文本。测试里有强断言锁住这一点。

**支持的接口**

| 接口 | 说明 |
|---|---|
| `POST /v1/chat/completions` | 主接口，支持流式与非流式、标准多模态图片输入 |
| `GET /v1/models` | 模型列表，声明支持图片与可用模式 |
| `GET /v1/models/{id}` | 单个模型信息 |
| `POST /v1/images/generations` | 以文生图节点形状返回提示词（`b64_json` 内联），方便接到已有的出图工作流 |

**控制输出的小语法**（都可选）

| 写法 | 作用 |
|---|---|
| system 里写 `Always use Ref2VA` / `请用 I2VA` | 强制模式，优先于自动判定 |
| 文本里写 `mode:Ref2VA` / `模式=FL2VA` / `--mode I2VA` | 同上（内联标记） |
| 文本或 system 里写 `返回 json 格式` | 返回结构化 JSON 而不是纯提示词 |

**鉴权**：设置 `H3_SERVER_API_KEY` 后，所有 `/v1/*` 请求都要带 `Authorization: Bearer <key>`（也接受 `x-api-key`）。**未设置时接口是开放的**，启动日志会明确警告——只有在你确定端口不对其他人开放时才这样用。

## 5. 生成的提示词长什么样

一次请求内部是两阶段：

```
输入 → [规划] → 模式判定 → 选指南 → [生成] → JSON 提取 → 规范校验 → [自动修复] → 结果
        ↓ 小模型/小调用                ↓ 只注入对应那一份指南        ↓ 不合格就重写
```

**规划阶段**先判定用哪个模式和哪份指南——这一步交给模型而不是正则，因为"这张图是首帧还是仅仅形象参考"必须看图才判得准。正则会大量误判，而这是最要紧的一个岔路：

- 图作为 0.00 秒的实际首帧 → `I2VA`
- 两张图分别是首尾帧 → `FL2VA`
- 图只是形象 / 场景 / 风格 / 分镜草图参考 → `Ref2VA`（六段式）

**生成阶段**只注入对应的那一份指南，所以基础模式不会白付 `ref-en.txt` 的 token，反之亦然。

基础模式（T2VA / I2VA / FL2VA / L2VA）输出三段式：

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, ... 他压低声音说：<d>[Chinese] 东西还在。</d> [Shot 2] At 00:04.500, the camera cuts to ...

overall_soundscape: ...

non_diegetic_music: ...
```

Ref2VA 输出官方六段式：`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。

台词一律**原样保留原文语言**，只放进 `<d>[Language] ...</d>`，不翻译不改标点——这正是官方规范的要求，校验器会检查。

## 6. 校验器检查什么

`src/validate.js` 直接对着官方两份指南写，分 `error`（触发自动修复）和 `warning`（只提示）：

**error**
- 三段式 / 六段式字段缺失、**顺序错误**
- `mode` 声明与正文结构不一致（说 T2VA 却写了六段式）
- 切镜时间未严格递增，或超出视频总时长
- `duration_sec` 不在官方 4–15 秒区间
- I2VA / FL2VA / L2VA 缺少官方规定的关键帧对齐指令首行
- `[Shot 1]` 带了时间戳（时间戳只能用于后续切镜）
- 台词 `<d>` 缺少 `[Language]` 语言标签

**warning**
- 参考标签 `<Subject N>` 出现了却未在 `subject_definitions` 中定义
- `retention_analysis` 里出现了 `(Sx)` 说话人编号（规范不允许）
- 分镜编号不连续、`shot_count` 与正文不符
- 描述长度不达规范建议（基础模式 < 80 词、Ref2VA < 250 词）

校验不通过时，把**具体问题清单**回灌给模型重写（默认 1 次，可在设置里调 0–2）。

## 7. 目录结构

```
├── skills/h3-prompt-writing/      官方 skill 原文（勿手改）
│   ├── SKILL.md
│   ├── references/base-en.txt
│   ├── references/ref-en.txt
│   └── MANIFEST.json              上游 commit + 每个文件的 sha256
├── src/
│   ├── server.mjs                 HTTP 服务、OpenAI 兼容路由、NDJSON 流式接口
│   ├── openai-api.mjs             OpenAI 协议适配：请求解析、鉴权、响应渲染
│   ├── config.js                  provider 预设、环境变量探测、本地配置
│   ├── llm.js                     OpenAI 兼容客户端（流式 + 非流式 + 视觉）
│   ├── prompts.js                 三层提示词编排、模式路由、官方文件加载
│   ├── generate.mjs               编排管线：规划→生成→提取→校验→修复
│   ├── validate.js                规范校验器
│   ├── json-extract.js            容错 JSON 提取
│   ├── incremental-json.js        流式增量字段解码（前后端共用）
│   └── images.js                  图片校验、真实格式嗅探、分辨率解析
├── web/                           前端（原生 ES module，无构建步骤）
├── test/                          72 项测试 + mock 模型
├── scripts/
│   ├── sync-h3-skill.mjs          重新同步官方 skill
│   ├── smoke.mjs                  离线端到端冒烟
│   ├── check-frontend.mjs         前端流式解码器检查
│   └── mock-upstream.mjs          给容器验证用的 mock 模型
├── Dockerfile / docker-compose.yml / .env.example
```

### 更新官方 skill

官方仓库更新后：

```bash
node scripts/sync-h3-skill.mjs            # 重新拉取 main
$env:H3_REF="v1.2.3"; node scripts/sync-h3-skill.mjs   # 或指定 tag/commit
```

会重写文件并更新 `MANIFEST.json` 里的 sha256。`test/skill.test.mjs` 会校验文件与清单一致，所以同步后测试会告诉你有没有意外改动。**建议固定 commit 而不是跟随 `main`**，避免上游改动让线上行为漂移。

## 8. HTTP 接口

### 内部接口（网页用，不带鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 单页界面 |
| GET | `/api/health` | 存活探针 |
| GET | `/api/skill` | 已加载的官方 skill 元信息 + 内容哈希 |
| GET | `/api/providers` | provider 预设与规格上限 |
| GET | `/api/config` | 生效配置（**API Key 永不下发前端**） |
| PUT | `/api/config` | 保存 provider / baseUrl / model / key 覆盖 |
| POST | `/api/generate` | 生成，返回 **NDJSON 事件流** |

`/api/generate` 请求体：

```json
{
  "text": "小说或分镜文字",
  "images": [{ "name": "a.png", "dataUrl": "data:image/png;base64,..." }],
  "durationSec": 8,
  "ratio": "16:9",
  "mode": "auto",
  "deepDive": false
}
```

事件流（每行一个 JSON）：

| `type` | 含义 |
|---|---|
| `stage` | 阶段推进（intake / plan / generate / repair） |
| `intake` | 图片接收确认 + skill 元信息 |
| `plan` | 模式判定与分析结果 |
| `warning` | 非致命提示 |
| `delta` | 模型输出增量（前端据此实时渲染提示词） |
| `result` | 最终结果：prompt、校验、用量、耗时 |
| `error` | 失败原因 |

前端会在收到 `delta` 时**增量解码** JSON 流里的 `prompt` 字段，所以你是在生成过程中看着提示词逐渐成型，而不是等一大坨 JSON 结束。

### 对外接口

见上面第 4 节的表。所有 `/v1/*` 路由在设置了 `H3_SERVER_API_KEY` 时都需要 Bearer 鉴权，并带 CORS 头（允许浏览器直接调用）。

## 9. 安全与边界

- **两个 Key 是两回事**，别混淆：
  - `apiKey` / `NEWAPI_API_KEY` 等 = **出站**，本项目拿去调用上游模型，消耗你的额度。
  - `H3_SERVER_API_KEY` = **入站**，别人调用本项目的 `/v1/*` 时必须出示。

### 对外暴露时的两个面（重要）

服务被 NewAPI 从**另一台机器**调用时，必须监听所有网卡：

```ini
HOST=0.0.0.0
H3_SERVER_API_KEY=sk-一串随机字符
```

一旦对外监听，两个面的权限是**刻意分开**的，用两套互不通用的凭据：

| 面 | 路径 | 来源 | 凭据 |
|---|---|---|---|
| 对外接口 | `/v1/*` | 任意机器 | `H3_SERVER_API_KEY`（`Authorization: Bearer`） |
| 网页控制台 | 网页 `/`、`/api/*` | 任意机器 | **登录会话**（用户名 + 密码） |

两者**不可互相替代**：网页登录不能用来调 `/v1/*`，API Key 也不能读改配置。测试对这两条都有断言。

`/api/health` 与静态资源（`app.js` / `app.css`）保持公开：容器健康检查要用前者，登录页要渲染必须能拿到后者。

### 网页控制台登录

首次启动**必须**通过环境变量设置密码，否则控制台直接不可用（服务会拒绝，而不是裸奔）：

```ini
H3_WEB_USERNAME=admin
H3_WEB_PASSWORD=换成你的强密码
```

- 密码**只以 scrypt 哈希存储**（`config.local.json` 里的 `webPasswordHash`），每个安装独立随机盐，明文不落盘。校验用常数时间比较。
- 会话存在服务端内存里，Cookie 只带一个随机 token，并带 `HttpOnly` + `SameSite=Strict`；**重启服务即全部失效**。
- 登录失败会限速：15 分钟内连续失败 8 次后锁定，锁定期间**即使密码正确也拒绝**。
- 改密码：`node scripts/set-web-password.mjs admin '新密码'`（写入哈希），或改 `H3_WEB_PASSWORD` 后重启。

> ⚠️ **公网部署务必套 TLS**（Caddy/Nginx 反代）。HTTP 明文下，登录密码和 `/v1` 的 API Key 都会在网络上裸奔。

启动脚本 `.\start.ps1` 会读 `.env.local` 做启动自检：**对外监听却没设入站 Key 时直接拒绝启动**，而不是印个警告继续跑——那种情况下静默运行就等于把额度公开。

- **API Key 只存服务端**：`config.local.json`（已在 `.gitignore` 里）或环境变量；`/api/config` 返回体绝不含 Key，测试有专门断言。
- **路径穿越防护**：静态资源被限制在 `web/` 内，`/../package.json` 会被拒绝。
- **上传校验**：单张 ≤ 8MB、最多 9 张（H3 Ref2VA 规格）、总 ≤ 40MB；服务端按 magic bytes 嗅探真实格式，不信任前端声明的 MIME。
- **Docker**：默认以非 root 的 `node` 用户运行；配置写在 `/data` 卷上，所以镜像可以只读、可随时替换。生产环境建议再加 `read_only: true` 并保留 `/data` 可写。
- 你的素材会发送给所选模型提供方，并受其内容审核约束。H3 服务本身也带审核。请确保素材合法且你拥有相应权利。

### 已知限制（如实说明）

- **不做视频生成**：本版本只产出提示词。接 H3 出片需要另外对接 MiniMax 开放平台 `/video-generation-v2-create` 的异步任务与轮询。
- **单次 4–15 秒**：这是 H3 单次生成的硬上限。如果小说片段很长，规划阶段会挑最有代表性的一个节拍，并在"用户未交代/已补全"里明确告诉你，而不是偷偷丢内容。
- **长文本需自己切分**：没有做章节切分与多镜头批量编排。
- **模型能力决定上限**：本地模型（7B 级）在 Ref2VA 六段式上容易漏段。建议至少用 Qwen-VL-Max / GLM-4V-Plus 级别。
- **未用真实 API Key 验证过端到端**：开发环境没有任何可用的模型 Key，因此所有验证都基于协议级 mock（`test/mock-llm.mjs` 真实实现了 SSE 流式与 OpenAI 报文），外加一次真实的 Docker 容器端到端验证。首次接入真实 provider 时请留意各家在图片格式、`max_tokens` 上限、流式 `usage` 字段上的差异。
- **`config.local.json` 里的 Key 是明文**：适合单机自用；多人环境请改用环境变量或密钥管理服务。

## 10. 下一步可以做什么

按投入产出排序：

1. **接 H3 出片**：拿到提示词后一键调用 `/video-generation-v2-create`，加异步轮询与结果回显。这一步能立刻把"工具"变成"工作流"。
2. **多镜头批量**：长片段自动切分成 N 个 4–15 秒镜头，输出一组提示词并可批量提交。
3. **人工确认关卡**：模式判定置信度低时，让用户先确认图是首帧还是参考，再生成——避免白烧一次生成费用。
4. **提示词库与版本对比**：保存历史、A/B 对比同一素材的不同提示词产出效果。
5. **配 NewAPI 的额度与分组**：把 `h3-prompt-writing` 放进独立分组、单独定价，便于区分成本。
