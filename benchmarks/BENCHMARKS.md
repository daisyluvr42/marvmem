# MarvMem Benchmarks

**April 2026 — 基准测试结果**

---

## 测试条件

以下所有结果均在 **零外部依赖、零 API 调用** 的条件下取得：

- 不使用任何 embedding 模型（使用内置的 FNV-1a hash embedding，128 维）
- 不调用任何 LLM
- 不使用任何外部向量数据库
- 唯一依赖是 Node.js 内置的 `node:sqlite`

这些数字代表的是 MarvMem 的 **baseline floor**，不是上限。MarvMem 的架构支持接入 remote embedding（OpenAI / Gemini / Voyage）和 LLM rerank，启用后预计会显著提升弱项表现。

---

## 核心数字

| Benchmark | Questions | R@5 | R@10 | NDCG@5 | NDCG@10 | Speed |
|---|---|---|---|---|---|---|
| **LongMemEval** | 500 | **89.6%** | **94.6%** | 0.818 | 0.834 | 28ms/q |
| **LoCoMo** | 1986 | **84.1%** | **92.0%** | — | 0.733 | 4.8ms/q |

总耗时 24 秒，在 M 系列 Mac 上完成。

---

## LongMemEval

LongMemEval 是标准的 AI 记忆检索 benchmark。500 个问题，每个问题从 ~48 个对话 session 中检索包含答案的目标 session，覆盖 6 种记忆检索场景。

### 按题目类型分解

| Question Type | R@5 | R@10 | Count |
|---|---|---|---|
| knowledge-update | **96.2%** | **100.0%** | 78 |
| multi-session | **95.5%** | **98.5%** | 133 |
| single-session-user | **92.9%** | **98.6%** | 70 |
| temporal-reasoning | **91.7%** | **94.0%** | 133 |
| single-session-assistant | **80.4%** | **85.7%** | 56 |
| single-session-preference | **46.7%** | **73.3%** | 30 |

### 优势

- **knowledge-update（96.2% R@5, 100% R@10）**：MarvMem 的 lexical overlap + recency 加权在知识更新类问题上表现极强。当事实随时间改变时，五维评分的 recency 维度自然倾向于最新版本。
- **multi-session（95.5% R@5）**：跨 session 的问题需要从多个候选中找到正确的那一个，MarvMem 的 token overlap 评分在关键词明确的情况下非常有效。
- **temporal-reasoning（91.7% R@5）**：时间推理类问题受益于 hash embedding 对日期文本的匹配能力。

### 劣势

- **single-session-preference（46.7% R@5）**：最明显的弱项。这类问题问的是间接表达的偏好（如"我一般更喜欢 X"），问题和目标 session 之间存在词汇鸿沟。128 维 hash embedding 缺乏真正的语义理解能力，无法跨越这个鸿沟。
- **single-session-assistant（80.4% R@5）**：当问题用不同措辞描述 AI 的回答时，shallow embedding 的匹配能力不足。

这两个弱项的根本原因都是语义理解能力。接入 sentence transformer（如 all-MiniLM-L6-v2、bge-large）或 remote embedding（OpenAI text-embedding-3-small 等）后，预计这两类的表现会大幅提升。MarvMem 的 retrieval 层已经内置了 remote embedding rerank 的支持——只需在配置中启用即可，不需要改代码。

---

## LoCoMo

LoCoMo 是多轮对话记忆 benchmark。10 个长对话（每个包含 19-32 个 session，双人对话），共 1986 个 QA 对，覆盖 5 种题目类型。

### 按题目类型分解

| Category | R@5 | R@10 | Count |
|---|---|---|---|
| temporal-inference | **90.1%** | **95.1%** | 446 |
| adversarial | **89.7%** | **96.1%** | 841 |
| single-hop | **75.5%** | **90.1%** | 282 |
| temporal | **76.0%** | **85.4%** | 321 |
| open-domain | **60.4%** | **70.8%** | 96 |

### 优势

- **adversarial（96.1% R@10）**：这类问题涉及说话人混淆——问题可能用 A 的名字问 B 说过的话。MarvMem 的 scope-aware 设计通过将每个 session 绑定到独立 scope 天然缓解了这个问题。这是架构优势，不依赖 embedding 质量。
- **temporal-inference（95.1% R@10）**：跨 session 的时间推理是多数系统的难点，MarvMem 在这个类别上表现出色。

### 劣势

- **open-domain（70.8% R@10）**：开放域问题需要较强的语义匹配能力，hash embedding 在这里的局限性最为明显。接入 remote embedding 后，这类问题的检索质量预计会有最大的边际提升。
- **temporal（85.4% R@10）**：部分时间问题需要理解"上个月""两周前"这类相对时间表达，纯文本匹配难以处理。可以通过 LLM rerank 让模型理解时间语义来改善。

### 各对话的结果

| Conversation | Sessions | QAs | R@10 |
|---|---|---|---|
| conv-43 | 29 | 242 | 95.0% |
| conv-26 | 19 | 199 | 95.0% |
| conv-48 | 30 | 239 | 93.3% |
| conv-30 | 19 | 105 | 93.3% |
| conv-50 | 30 | 204 | 93.1% |
| conv-42 | 29 | 260 | 91.2% |
| conv-41 | 32 | 193 | 90.7% |
| conv-47 | 31 | 190 | 90.0% |
| conv-44 | 28 | 158 | 89.2% |
| conv-49 | 25 | 196 | 88.8% |

---

## 关于弱项的补充说明

上述所有弱项均出现在 **零 API 调用** 的 baseline 条件下。MarvMem 的实际部署场景中，用户可以：

1. **接入 remote embedding 模型**（已内置支持 OpenAI / Gemini / Voyage），在 builtin 评分的基础上叠加 35% 权重的向量 rerank
2. **接入 LLM rerank**（如 Haiku、Gemini Flash），让语言模型对 top-K 候选做阅读理解级别的重排序
3. **调整 search weights**，针对具体使用场景优化 lexical / hash / recency / importance / scope 五个维度的权重比例

因此，benchmark 中暴露的弱项（尤其是 preference 和 open-domain 类别）在实际使用中不一定是瓶颈——它们反映的是 baseline 的下限，而不是系统能力的上限。

---

## Reproducibility

### 环境

- Node.js >= 22.13.0（使用 `node:sqlite` 内置模块）
- 无外部依赖
- 确定性结果：相同数据 + 相同参数 = 相同分数

### 运行 LongMemEval

```bash
# 下载数据集（约 277MB）
curl -fsSL -o benchmarks/longmemeval/longmemeval_s_cleaned.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"

# 运行（约 14 秒）
npm run bench:lme
```

### 运行 LoCoMo

```bash
# 下载数据集（约 3MB）
curl -fsSL -o benchmarks/locomo/locomo10.json \
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"

# 运行（约 10 秒）
npm run bench:locomo
```

### 自定义参数

```bash
# 只跑前 50 个问题
npm run bench:lme -- --limit 50

# 调整 search weights
npm run bench:lme -- --weights '{"lexical":0.5,"hash":0.3,"recency":0.08,"importance":0.07,"scope":0.05}'

# 指定输出路径
npm run bench:locomo -- --output benchmarks/results/my_run.jsonl
```

---

## 测试方法

### 存储方式

每个 session 作为一条 palace record 存入 MarvMem（`kind: "session"`，`scope.type: "session"`），检索时用五维加权评分。Dedup 设为禁用（`dedupeThreshold: 1`），确保每个 session 独立存储。

### 评估指标

- **R@K（Recall at K）**：ground-truth session 是否出现在 top-K 检索结果中
- **NDCG@K**：带位置权重的排序质量，ground-truth 排名越靠前分数越高
- 这些是**检索召回率**，不是端到端 QA 准确率

### 为什么不测 Active Memory 和 Task Context

这些 benchmark 测的是**基础检索能力**。Active memory（压缩上下文）和 task context（任务工作记忆）是更高层的抽象，在实际使用中提升的是 prompt 质量和记忆管理效率，但不直接参与检索 benchmark。

---

## 结果文件

| File | Benchmark | Score |
|---|---|---|
| `lme_marvmem_20260419T132203.jsonl` | LongMemEval | 89.6% R@5, 94.6% R@10 |
| `locomo_marvmem_20260419T132509.jsonl` | LoCoMo | 84.1% R@5, 92.0% R@10 |

每个 JSONL 文件的每一行包含：question ID、检索到的 record ID 及分数、ground truth、hit@K、NDCG、耗时。所有结果可审计。

---

*Results verified April 2026. Zero external dependencies. Zero API calls.*
