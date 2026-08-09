# Review Boundary Kernel (RBK) — 設計

> **一つの問いだけを扱う: この行為を、人間を通さずに適用してよいか。**

## 1. 何であり、何でないか

RBK は「AI が提案した個々の行為を、自動適用してよいか / 人間に回すか / 判断できないか」を**決定論的に計算する**契約層である。

- ❌ 品質を測定しない(測定結果は入力)
- ❌ 修正を生成しない(生成物は入力)
- ❌ 認証・認可の実装ではない(認証済みの権限は入力)
- ✅ 測定結果・権限・鮮度・可逆性から**境界を計算し、その根拠を残す**

対象は artifact 非依存。コードレビュー(reviewgraphen)、RAG 評価の改善適用(Assay Kit)、エージェントの副作用承認(Cloudflare OS Gatekeeper ApprovalQueue)のいずれにも同じ契約で載る。

## 2. なぜ必要か

2026 年、診断→修正エージェントは各社が出荷した(LangSmith Engine、Arize Signal、AWS AgentCore、Latitude 等)。しかし**「その修正を自動適用してよいか」を機械が計算する製品は存在しない** — 全社が「一律に人間が承認する」で止まっている。auto-fix が普及するほど、この判定の需要は構造的に増える。

隣接する先行例:
- **OpenAI Auto-review**(2026-04): セキュリティ境界の機械承認(実効承認率 99.93%)。品質境界ではない
- **Microsoft Agent Governance Toolkit**: 主体の連続トラストスコア。決定は離散3値で、**個別アクションの境界計算ではない**
- **Cloudflare OS Gatekeeper**: `submitAction()` の承認キューは**二値**(副作用があれば人間へ)

RBK は「主体の信頼度」ではなく「**個別アクションの、証拠と権限に基づく境界**」を計算する点で異なる。

## 3. 三値と、その非対称性

```
auto_apply       機械が適用してよい
human_required   人間の判断が要る(理由が確定している)
incomplete       判断できない(境界の計算に必要なものが欠けている)
```

**`incomplete` を `human_required` に潰してはならない。** 両者は運用上も意味が違う:

- `human_required` = 制度上・リスク上、人間が決めるべきだと**分かっている**
- `incomplete` = 本来なら自動適用できたかもしれないが、**それを示せない**

`incomplete` は「計算基盤の欠損」を可視化する信号であり、これを人間レビューに混ぜると欠損が永久に見えなくなる。reviewgraphen の Gate 三値(`pass`/`blocked`/`incomplete`)、sdde の四状態における `unknown` と同じ規律である。

### 合成規則(単調な狭まり)

```
いずれかの factor が human_required  → human_required
それ以外で incomplete がある          → incomplete
すべて satisfied                     → auto_apply
```

確定した制限は不確実性に優先する(人間が要ると分かっているなら、他が不明でも答えは出ている)。結果として **`incomplete` は「自動適用したかったができなかった」場合にのみ現れる** — 最も価値の高い信号だけが残る。

権限は**狭まる方向にしか動かない**(AAM の Trust Ratchet と同型)。policy の ceiling から出発し、各 factor は緩めない。

## 4. Factor(判定の分解軸)

| factor | 問い | 由来 |
|---|---|---|
| `applicability` | この policy はこの行為に適用可能か | sdde(`capability_missing ≠ not_applicable`) |
| `authority` | 要求される agency 次元を非人間が持ってよいか | GAE 7次元 / Actoric Authority |
| `evidence` | evidence_requirement を満たす証拠があるか | reviewgraphen `evidenceRequirement` |
| `freshness` | その証拠は今も有効か | reviewgraphen staleness 12分類 / sdde 鮮度帰属 |
| `risk` | impact / exposure が閾値内か | reviewgraphen `risk` |
| `reversibility` | 失敗時に取り消せるか、補償できるか | Actoric(Rollback Fiction の禁止) |

各 factor は独立に `satisfied` / `human_required` / `incomplete` を返し、**理由を必ず添える**。理由のない制限は出力しない。

### agency 次元(GAE 由来・RBK の差別化点)

境界は「適用可否」の一値ではなく、**次元ごとに引ける**:

```
O observe / F frame / P project / J judge / U authorize / E execute / L learn
```

例: 「AI は P(構想)と E(実行)を持ってよいが、F(問題設定)と U(授権)は持てない」。
`U`(授権)を非人間に与えることは既定で禁止する — 授権の委譲は責任洗浄(Responsibility Washing)に直結するため、policy が明示的に許可した場合のみ通す。

## 5. 同一性と帰属

sdde `docs/16` §10 の分離規律を採用する。

```
evidence_state_digest = hash(証拠の状態のみ)        ← policy を含めない
decision_id           = hash(action_digest, evidence_state_digest, policy_id)
```

policy を変えても `evidence_state_digest` は変わらない。これにより「同じ証拠に別の policy を当てる」比較が可能になり、**決定が変わった原因を機械的に切り分けられる**:

```
action_digest のみ変化          → action change
evidence_state_digest のみ変化  → evidence change
policy_id のみ変化              → policy change
複数変化                        → 分離不能。その旨を宣言する(推測しない)
```

「分離できない比較を単一原因として提示しない」— sdde の規律をそのまま継承する。

## 6. 出力に対する禁止事項

- `incomplete` を `human_required` として集計しない
- 満たされなかった factor を出力から省略しない(欠損は欠損として残す)
- 確率・スコアを「証明」と表示しない(測候方法論 §3.4 保証境界: `evaluator_supported` を `proved` と表示してはならない)
- policy 変更を evidence 変更として帰属しない

## 7. 契約

| ファイル | 役割 |
|---|---|
| `schemas/rbk.policy.v1.schema.json` | 境界の上限(ceiling)・閾値・権限地図 |
| `schemas/rbk.request.v1.schema.json` | 行為 + 証拠状態(計算の入力) |
| `schemas/rbk.decision.v1.schema.json` | 三値 + factor 別の根拠 + 同一性 |

実装は言語非依存(Rust の reviewgraphen、TypeScript の Assay Kit / Cloudflare OS Gadget の双方から使う)。共有するのは**コードではなく契約と語彙**である。
