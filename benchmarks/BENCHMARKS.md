# MarvMem Benchmarks

**April 2026 — 基准测试结果**

---

## 核心数字

MarvMem 在两种模式下进行了测试：

- **Builtin（零 API）**：仅使用内置的 FNV-1a hash embedding（128 维）和五维加权评分，无任何外部依赖
- **+ BGE-M3（本地）**：在 builtin 评分基础上叠加本地 BGE-M3 embedding rerank（1024 维，权重 65% builtin + 35% vector）
- **+ Gemini embedding-001（云端）**：同样的 rerank 架构，embedding 换成 Gemini embedding-001（3072 维）

| Benchmark | Mode | R@5 | R@10 | NDCG@10 | Speed | LLM | Cost |
|---|---|---|---|---|---|---|---|
| **LongMemEval** (500q) | Builtin | 89.6% | 94.6% | 0.834 | 28ms/q | None | $0 |
| **LongMemEval** (500q) | + BGE-M3 | 95.8% | 97.6% | **0.915** | 8.7s/q | None | $0 |
| **LongMemEval** (500q) | **+ Gemini** | **96.2%** | **97.6%** | 0.902 | 3.6s/q | None | ~$0.24 |
| **LoCoMo** (1986q) | Builtin | 84.1% | 92.0% | 0.733 | 4.8ms/q | None | $0 |
| **LoCoMo** (1986q) | **+ BGE-M3** | **88.3%** | **94.8%** | **0.789** | 1.3s/q | None | $0 |
| **LoCoMo** (1986q) | + Gemini | 87.6% | 94.2% | 0.775 | 0.7s/q | None | ~$0.10 |

Builtin 模式总耗时 24 秒。BGE-M3 模式受限于本地 CPU 推理速度，两次完整测试合计约 113 分钟。Gemini 模式总耗时约 53 分钟，速度约为本地 BGE-M3 的 2.4 倍。

---

## 测试条件

### Builtin（零 API 模式）

- 不使用任何 embedding 模型（使用内置的 FNV-1a hash embedding，128 维）
- 不调用任何 LLM
- 不使用任何外部向量数据库
- 唯一依赖是 Node.js 内置的 `node:sqlite`

### Hybrid（+ BGE-M3，本地）

- 在 builtin 五维评分的基础上，叠加 BGE-M3（BAAI/bge-m3，1024 维）的 cosine similarity 作为 rerank 信号
- 混合权重：`score = builtin_score × 0.65 + vector_score × 0.35`
- embedding 在本地运行（LM Studio），不调用任何远程 API
- 仍然不使用任何 LLM

### Hybrid（+ Gemini embedding-001，云端）

- 同样的 rerank 架构，embedding 换成 Google Gemini embedding-001（3072 维）
- 通过 Gemini API 调用，使用 `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT` task type
- 仍然不使用任何 LLM

---

## LongMemEval

500 个问题，每个问题从 ~48 个对话 session 中检索包含答案的目标 session，覆盖 6 种记忆检索场景。

### 按题目类型分解

| Question Type | Count | Builtin R@5 | + BGE-M3 R@5 | + Gemini R@5 | Builtin R@10 | + BGE-M3 R@10 | + Gemini R@10 |
|---|---|---|---|---|---|---|---|
| knowledge-update | 78 | 96.2% | **100.0%** | **100.0%** | 100.0% | **100.0%** | **100.0%** |
| single-session-user | 70 | 92.9% | **98.6%** | **98.6%** | 98.6% | **100.0%** | 98.6% |
| multi-session | 133 | 95.5% | 97.7% | **98.5%** | 98.5% | 98.5% | **98.5%** |
| single-session-assistant | 56 | 80.4% | **94.6%** | **94.6%** | 85.7% | **94.6%** | **94.6%** |
| temporal-reasoning | 133 | 91.7% | 94.0% | **94.7%** | 94.0% | **97.7%** | **97.7%** |
| single-session-preference | 30 | 46.7% | **80.0%** | **80.0%** | 73.3% | 86.7% | **90.0%** |

### 优势

- **knowledge-update（100.0%）**：接入 BGE-M3 后达到满分。MarvMem 的 lexical overlap + recency 加权在知识更新类问题上表现极强。
- **single-session-user（98.6%）**：用户发言类检索几乎完美。
- **multi-session（97.7%）**：跨 session 的问题需要从多个候选中找到正确的那一个，MarvMem 的 token overlap 评分在关键词明确的情况下非常有效。
- **single-session-assistant（94.6%）**：接入 BGE-M3 后提升 14.2pp，embedding 的语义匹配能力有效弥补了 hash 在重述检测上的不足。

### 劣势

- **single-session-preference（80.0% R@5 / 90.0% R@10 with Gemini）**：仍然是最弱的类别。Gemini 的 3072 维在 R@10 上比 BGE-M3 的 1024 维多拿了 3.3pp（90.0% vs 86.7%），说明更高维度的语义理解对间接偏好检索有帮助，但这个类别仍需偏好提取机制来进一步突破。
- **temporal-reasoning（94.7% R@5 with Gemini）**：部分涉及"X 天前"等相对时间表达的问题需要数值推理，纯检索手段难以完全覆盖。

### Miss 分析（BGE-M3 模式，12/500 miss）

500 个问题中仅有 12 个在 R@10 上 miss，主要分布在：
- 4 个 single-session-preference（间接偏好）
- 3 个 temporal-reasoning（相对时间计算）
- 3 个 single-session-assistant（AI 回答重述）
- 2 个 multi-session（跨 session 数值聚合，如"我看了多少个医生"）

---

## LoCoMo

10 个长对话（每个包含 19-32 个 session，双人对话），共 1986 个 QA 对，覆盖 5 种题目类型。

### 按题目类型分解

| Category | Count | Builtin R@5 | + BGE-M3 R@5 | + Gemini R@5 | Builtin R@10 | + BGE-M3 R@10 | + Gemini R@10 |
|---|---|---|---|---|---|---|---|
| adversarial | 841 | 89.7% | **92.9%** | 92.4% | 96.1% | **97.5%** | 97.4% |
| temporal-inference | 446 | 90.1% | **92.4%** | **92.4%** | 95.1% | **97.1%** | 96.2% |
| single-hop | 282 | 75.5% | **82.6%** | 79.4% | 90.1% | **94.0%** | 93.3% |
| temporal | 321 | 76.0% | **82.2%** | **82.2%** | 85.4% | **91.6%** | 89.7% |
| open-domain | 96 | 60.4% | **65.6%** | 64.6% | 70.8% | **74.0%** | **74.0%** |

### 优势

- **adversarial（97.5% R@10）**：说话人混淆类问题。MarvMem 的 scope-aware 设计通过将每个 session 绑定到独立 scope 天然缓解了这个问题。这是架构优势，不依赖 embedding 质量。
- **temporal-inference（97.1% R@10）**：跨 session 的时间推理是多数系统的难点，MarvMem 在这个类别上表现出色，受益于五维评分中的 recency 维度。

### 劣势

- **open-domain（74.0% R@10）**：开放域问题需要较强的语义匹配能力。即使接入 BGE-M3 后，这个类别的提升也有限（+3.2pp），说明需要更强的 embedding 模型或 LLM rerank 来进一步提升。
- **temporal（91.6% R@10）**：部分时间问题需要理解"上个月""两周前"这类相对时间表达，接入 BGE-M3 后改善最大（+6.2pp），但仍有提升空间。

### 各对话的结果（BGE-M3 模式）

| Conversation | Sessions | QAs | Builtin R@10 | + BGE-M3 R@10 |
|---|---|---|---|---|
| conv-26 | 19 | 199 | 95.0% | **97.0%** |
| conv-50 | 30 | 204 | 93.1% | **96.6%** |
| conv-43 | 29 | 242 | 95.0% | **96.3%** |
| conv-30 | 19 | 105 | 93.3% | **95.2%** |
| conv-42 | 29 | 260 | 91.2% | **95.0%** |
| conv-48 | 30 | 239 | 93.3% | **94.6%** |
| conv-47 | 31 | 190 | 90.0% | **94.7%** |
| conv-41 | 32 | 193 | 90.7% | **93.8%** |
| conv-44 | 28 | 158 | 89.2% | **92.4%** |
| conv-49 | 25 | 196 | 88.8% | **91.8%** |

---

## 关于弱项的补充说明

上述弱项在接入 embedding 后已经有显著改善（preference +33pp，assistant +14pp，temporal +6pp）。两个 embedding 提供者的特点：

- **BGE-M3（本地，1024 维）**：LoCoMo 各类目全面更强，NDCG 更高，适合对数据隐私敏感或需要零 API 调用的场景
- **Gemini embedding-001（云端，3072 维）**：LME R@5 最高（96.2%），preference R@10 最高（90.0%），速度更快，适合对延迟和 preference 检索有更高要求的场景

MarvMem 的架构还支持进一步提升：

1. **接入 LLM rerank**（如 Haiku、Gemini Flash），让语言模型对 top-K 候选做阅读理解级别的重排序
2. **调整 search weights 和 embedding weight**，针对具体使用场景优化各维度的权重比例

---

## Reproducibility

### 环境

- Node.js >= 22.13.0（使用 `node:sqlite` 内置模块）
- Builtin 模式：无外部依赖
- Hybrid 模式（本地）：需要 OpenAI-compatible embedding 服务（如 LM Studio、Ollama、vLLM）
- Hybrid 模式（云端）：需要 Gemini API key
- Builtin 模式结果是确定性的；Hybrid 模式在相同 embedding 服务、相同模型文件和相同参数下可复现到同一结果。不同服务、量化版本或服务端预处理可能带来轻微差异

### 运行 LongMemEval

```bash
# 下载数据集（约 277MB）
curl -fsSL -o benchmarks/longmemeval/longmemeval_s_cleaned.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"

# Builtin 模式（约 14 秒）
npm run bench:lme

# Hybrid 模式 — 本地 BGE-M3
node --experimental-strip-types benchmarks/longmemeval/bench.ts \
  --embed-url http://127.0.0.1:1234 --embed-model text-embedding-bge-m3

# Hybrid 模式 — Gemini embedding-001
node --experimental-strip-types benchmarks/longmemeval/bench.ts \
  --embed-provider gemini --embed-key YOUR_GEMINI_API_KEY
```

### 运行 LoCoMo

```bash
# 下载数据集（约 3MB）
curl -fsSL -o benchmarks/locomo/locomo10.json \
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"

# Builtin 模式（约 10 秒）
npm run bench:locomo

# Hybrid 模式 — 本地 BGE-M3
node --experimental-strip-types benchmarks/locomo/bench.ts \
  --embed-url http://127.0.0.1:1234 --embed-model text-embedding-bge-m3

# Hybrid 模式 — Gemini embedding-001
node --experimental-strip-types benchmarks/locomo/bench.ts \
  --embed-provider gemini --embed-key YOUR_GEMINI_API_KEY
```

### 自定义参数

```bash
# 只跑前 50 个问题
npm run bench:lme -- --limit 50

# 调整 embedding 权重（默认 0.35）
node --experimental-strip-types benchmarks/longmemeval/bench.ts \
  --embed-url http://127.0.0.1:1234 --embed-model text-embedding-bge-m3 --embed-weight 0.5

# 调整 search weights
npm run bench:lme -- --weights '{"lexical":0.5,"hash":0.3,"recency":0.08,"importance":0.07,"scope":0.05}'
```

---

## 测试方法

### 存储方式

每个 session 作为一条 palace record 存入 MarvMem（`kind: "session"`，`scope.type: "session"`），检索时用五维加权评分。Dedup 设为禁用（`dedupeThreshold: 1`），确保每个 session 独立存储。

### Hybrid 模式的 rerank 方式

Builtin search 返回 top-20 候选，然后对每个候选的文本做 embedding，计算 query 与 candidate 的 cosine similarity，最终分数为 `builtin_score × 0.65 + vector_score × 0.35`。LoCoMo 中做了优化：每个 conversation 的 sessions 只 embed 一次，query 按次计算。

### 评估指标

- **R@K（Recall at K）**：ground-truth session 是否出现在 top-K 检索结果中
- **NDCG@K**：带位置权重的排序质量，ground-truth 排名越靠前分数越高
- 这些是**检索召回率**，不是端到端 QA 准确率

### 为什么不测 Active Memory 和 Task Context

这些 benchmark 测的是**基础检索能力**。Active memory（压缩上下文）和 task context（任务工作记忆）是更高层的抽象，在实际使用中提升的是 prompt 质量和记忆管理效率，但不直接参与检索 benchmark。

---

## 结果文件

| File | Mode | Benchmark | Score |
|---|---|---|---|
| `lme_marvmem_20260419T132203.jsonl` | Builtin | LongMemEval | 89.6% R@5, 94.6% R@10 |
| `lme_marvmem_text_embedding_bge_m3_20260419T150927.jsonl` | + BGE-M3 | LongMemEval | 95.8% R@5, 97.6% R@10 |
| `lme_marvmem_gemini_embedding_001_20260420T041232.jsonl` | + Gemini | LongMemEval | 96.2% R@5, 97.6% R@10 |
| `locomo_marvmem_20260419T132509.jsonl` | Builtin | LoCoMo | 84.1% R@5, 92.0% R@10 |
| `locomo_marvmem_text_embedding_bge_m3_20260419T152821.jsonl` | + BGE-M3 | LoCoMo | 88.3% R@5, 94.8% R@10 |
| `locomo_marvmem_gemini_embedding_001_20260420T020126.jsonl` | + Gemini | LoCoMo | 87.6% R@5, 94.2% R@10 |

每个 JSONL 文件的每一行包含：question ID、检索到的 record ID 及分数、ground truth、hit@K、NDCG、耗时。所有结果可审计。

---

*Results verified April 2026. Builtin mode: zero external dependencies, zero API calls. Hybrid mode: local BGE-M3 or Gemini API embedding, zero LLM calls.*
