# Review Boundary Kernel (RBK)

「AIが提案した個々の行為を、人間を通さずに自動適用してよいか」を**決定論的に計算する**契約層。品質測定や修正生成、認証・認可そのものは行わず、測定結果・権限・鮮度・可逆性から境界を計算し、その根拠(factor別の判定と理由)を残す。artifact 非依存で、コードレビュー(reviewgraphen)、RAG 評価改善(Assay Kit)、エージェントの副作用承認(Cloudflare OS Gatekeeper)など、同じ契約に載せられる。

出力は三値: `auto_apply`(適用可)/ `human_required`(人間の判断が要ると分かっている)/ `incomplete`(判断に必要な情報が欠けている)。`incomplete` を `human_required` に潰さないことが設計の核。

詳細設計は [`docs/00_design.md`](docs/00_design.md) を参照。

## スキーマ

`schemas/` にある3つの JSON Schema(Draft 2020-12)が RBK の契約そのもの。

| ファイル | 役割 |
|---|---|
| `rbk.policy.v1.schema.json` | 境界の上限(ceiling)。権限地図・証拠要件・鮮度要件・リスク閾値・可逆性下限。 |
| `rbk.request.v1.schema.json` | 判定対象の行為(action)と、それを支える証拠状態(evidence_state)。計算の入力。 |
| `rbk.decision.v1.schema.json` | 三値の結論、6つの factor(applicability / authority / evidence / freshness / risk / reversibility)別の根拠、同一性(digest群)。計算の出力。 |

## fixtures

`fixtures/<シナリオ名>/` に `policy.json` / `request.json` / `expected-decision.json` を1組で置く。いずれもスキーマに適合する具体例。

| シナリオ | 概要 |
|---|---|
| `01-auto-apply` | 全 factor が satisfied → `auto_apply`。executable_test が passed/fresh、影響度 low、reversible、要求次元は project・execute のみ。 |
| `02-authority-withheld` | 要求次元に `authorize` が含まれるが policy の `non_human_may_hold` に無い → `human_required`。`withheld_dimensions` に `authorize`。 |
| `03-incomplete-stale-evidence` | 他は満たすが証拠が stale(`target_changed`)で policy `require_fresh=true` → `incomplete`。`routing.required_evidence_modes` に再検証すべき証拠種別。 |
| `04-human-required-risk` | 影響度 `critical` が policy `max_impact` を超過 → `human_required`。 |

いずれも factor は6種すべてを列挙し(satisfied も省略しない)、`satisfied` 以外の verdict には必ず `reasons` を添えている。digest 類はダミー値(`sha256:<64桁hex>`)。

## validate.py

`schemas/` と `fixtures/` の整合性を検査するスクリプト。

```bash
pip install jsonschema   # 未導入の場合
python3 validate.py
```

検査内容:

1. 3つのスキーマが Draft 2020-12 として妥当か
2. 各 fixture の `policy.json` / `request.json` / `expected-decision.json` が対応スキーマに適合するか
3. スキーマだけでは強制できない不変条件
   - factor が6種すべて揃っているか
   - `verdict != satisfied` な factor に `reasons` があるか
   - 合成規則(`human_required` > `incomplete` > `auto_apply`)が守られているか
   - `auto_apply` のとき `withheld_dimensions` が空か
   - `granted_dimensions` が `requested_dimensions` の部分集合か

全件 `PASS` なら exit 0、1件でも `FAIL` があれば exit 1。`jsonschema` が無ければ案内を出して exit 2。
