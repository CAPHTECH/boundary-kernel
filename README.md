# Review Boundary Kernel (RBK)

AI が提案した行為について、**一つの問いだけ**を扱う契約層です。

> **この行為を、人間を通さずに適用してよいか。**

答えは決定論的に計算されます。行き先は三値、それとは別に「その判定を支える証拠基盤が十分だったか」が一つの真偽値で返ります。同じ入力なら常に同じ答えが出て、なぜそう判定したかの理由が必ず添えられます。

> **ステータス: 実験的 (v0.3.0)。** スキーマはまだ固定していません。本番運用を前提にした保証はありません。v0.2 で `rbk.decision` に破壊的変更が入り(下記)、v0.3 で同一性に `identity.policy_digest` が必須フィールドとして加わっています(これも破壊的変更です)。

## 二軸 — routing と measurement

行き先は三値です。

```
auto_apply       機械が適用してよい
human_required   人間の判断が要る(理由が確定している)
incomplete       判断できない(境界の計算に必要なものが欠けている)
```

`incomplete` を `human_required` に潰さないことが設計の核です。両者は運用上の意味が違います。

- `human_required` = 制度上・リスク上、人間が決めるべきだと**分かっている**
- `incomplete` = 境界そのものが**計算できなかった**

⚠️ `incomplete` は「解決すれば `auto_apply` だった」を意味しません。欠けていた観測が埋まった結果 `human_required` になることもあります(例: `reversibility: unknown` が `irreversible` と判明する)。意味するのは達成可能性ではなく**計算不能**です。

**v0.2 の訂正。** v0.1 は「どこへ回すか」と「証拠基盤は十分だったか」を1つの値に畳んでいました。その結果、`human_required` が立つと同時に立っていた `incomplete` が捨てられていた — 設計自身が禁じている潰し方を実装がしていたことになります([独立レビューの指摘](docs/00_design.md#二軸に分ける--routing-と-measurementv02-で訂正))。v0.2 は軸を分けます。

| 問い | 軸 | フィールド |
|---|---|---|
| この行為をどこへ回すか | routing | `outcome`(三値) |
| 我々の証拠基盤は十分だったか | measurement | `basis_complete: boolean` |

いずれかの factor が `incomplete` 信号を1つでも出したら `basis_complete = false` になります。`outcome` が `human_required` でも、です。`outcome == incomplete` は「`basis_complete == false` かつ `human_required` が無い」場合と厳密に一致し、**基盤の欠損は outcome に関わらず必ず記録されます**。欠損を記録した decision は、行き先が `human_required` であっても「次に何を観測すべきか」を返します。

判定は6つの factor に分解されます: `applicability` / `authority` / `evidence` / `freshness` / `risk` / `reversibility`。各 factor は独立に verdict と `basis_complete` を返し、`satisfied` 以外には必ず理由が付きます。1つの factor が両方の信号を出したとき(例: 影響度が上限超過 **かつ** 不確実性が上限超過)、verdict は `human_required` ですが `basis_complete` は false のまま残ります。満たされなかった factor を出力から省くことはしません。

## 同一性 — 集合を順序で扱わない

`decision_id` と `evidence_state_digest` は、**意味の正規化を済ませた値**に対して計算されます(v0.2 で追加)。

- **集合として宣言された配列**(`requested_dimensions`、`evidence_state.items`、staleness の理由、など)は digest の前に正準順へ並べ替えます。並べ替えただけで digest が動くと、`attribute()` が実際には起きていない `evidence_change` を報告してしまうためです。
- **順序付きの配列**(`reasons` 類)はそのままです。順序それ自体がデータだからです。
- 文字列は **NFC** に正規化します。`canonical.ts`(直列化器)は Unicode 正規化も並べ替えもしません — RFC 8785 と同じく、それは意味の側の判断だからです。

どの配列が集合でどれが順序付きかは [`docs/00_design.md` §5](docs/00_design.md) の表と各スキーマの `description`(【集合】/【順序付き】)に明記してあります。暗黙にはしません。

**v0.3 の訂正 — policy を content hash で縛る。** v0.2 の `decision_id` は policy を `policy_id` と `version` というラベルでしか縛っておらず、同じラベルのまま内容を書き換えた policy は同じ `decision_id` を生み、`attribute()` は `no_change` と報告していました。設計文書はこれを「content hash を入れても同じ version のまま書き換えられたら検出できない」という理由で塞げない穴としていましたが、**この理由付けが誤りでした** — content hash はラベルと独立に内容の変更で動くので、まさにその書き換えを検出します。`identity.policy_digest`(必須)を追加し、`decision_id` の入力に含めました。`evidence_state_digest` は従来どおり policy を含みません(この分離が原因帰属を可能にしているため)。

詳細な設計根拠は [`docs/00_design.md`](docs/00_design.md) にあります。

## 何をしないか

- ❌ **品質を測定しない** — テスト結果や静的解析の結果は入力であって、RBK が生成するものではありません
- ❌ **修正を生成しない** — 適用対象の diff やパッチは入力です
- ❌ **認証・認可の実装ではない** — 認証済みの権限は入力です
- ✅ 測定結果・権限・鮮度・可逆性から**境界を計算し、その根拠を残す**

artifact 非依存です。コードレビューの自動マージ、RAG 評価の改善適用、エージェントの副作用承認 — いずれも同じ契約に載ります。共有するのはコードではなく契約と語彙です。

## 動かす

必要なもの: Node.js 22+(TypeScript を直接実行するため)、Python 3 と `jsonschema`(スキーマ検証のため)。

```bash
# TypeScript 参照実装 (tsc --noEmit + node:test, 155 テスト)
npm install
npm test

# スキーマと fixtures の整合性検査 (58 チェック)
pip install jsonschema
python3 validate.py

# 実地テストの再実行
node --experimental-strip-types experiments/herdr-approvals/run.ts
```

## 中身

| ディレクトリ | 内容 |
|---|---|
| `docs/00_design.md` | 設計正本。三値の非対称性と routing / measurement の二軸、factor の由来、同一性と帰属の規律。 |
| `schemas/` | 契約そのもの。`rbk.policy.v1` / `rbk.request.v1` / `rbk.decision.v2`(JSON Schema Draft 2020-12)。 |
| `fixtures/` | 5シナリオ。`auto_apply` / 権限の留保 / 証拠の陳腐化による `incomplete` / リスク超過による `human_required` / **`human_required` と基盤欠損の同時成立**。各 `policy.json` + `request.json` + `expected-decision.json`。 |
| `src/` | TypeScript 参照実装。ランタイム依存ゼロ。`decide()` は**同期の純関数**で、digest は引数で受け取るため crypto に依存しません。 |
| `test/` | fixtures との一致、routing 規則の網羅(3⁶ 全組み合わせ)、二軸の不変条件、境界条件(閾値ちょうど・欠損値・空配列)、同一性の束縛(policy を content hash で縛ること)、digest の決定論性と集合の順序非依存、変化の帰属。 |
| `experiments/herdr-approvals/` | 実地テスト(下記)。 |

`validate.py` はスキーマだけでは強制できない不変条件も検査します — factor が6種揃っているか、非 `satisfied` に理由があるか、routing 規則が守られているか、`basis_complete` が factor の連言になっているか、二軸の同値(`outcome == incomplete` ⟺ 基盤欠損かつ `human_required` 無し)が成り立つか、`auto_apply` なら留保次元が空か、など。

## 実地テスト: 6件中4件で一致

2026-08-09 のセッションで、オーケストレータがワーカーエージェントからのシェルコマンド要求を人間の目で承認/拒否した記録を、RBK で再現できるか試しました([`experiments/herdr-approvals/`](experiments/herdr-approvals/))。

| ケース | 人間の判断 | カーネル(outcome) | `basis_complete` | |
|---|---|---|---|---|
| `grep`(read-only) | auto_apply | auto_apply | true | ✔ |
| `git checkout -b` | auto_apply | auto_apply | true | ✔ |
| **`npm install`** | **auto_apply** | **human_required** | **false** | ✘ |
| `git commit` | auto_apply | auto_apply | true | ✔ |
| `git push` | human_required | human_required | true | ✔ |
| **ヒアドキュメント(静的解析不能)** | **auto_apply** | **incomplete** | **false** | ✘ |

v0.2 の二軸化で outcome は1件も変わっていません(6件中4件一致のまま)。増えたのは `basis_complete` 列で、`npm install` の基盤欠損は v0.1 では `human_required` に潰されて見えていませんでした。同じ `human_required` でも `git push` は `basis_complete = true` — 規約上人間が決めるべきだと分かっているだけで、観測が足りなかったわけではない、という区別です。

**不一致の2件は、どちらも人間の判断のほうが弱かった**ケースです。`npm install` は外部レジストリから未検査のコードを取得する操作を「ビルド確認に必要だから」で通していました。ヒアドキュメントの件は、人間が承認しつつメモに自分で「ここが最も危うい判断だった」と書いていた箇所です。カーネルはそこで `human_required` ではなく `incomplete` を返し、「解決に必要な観測: sandbox_scope_check, static_command_analysis」を示しました。二値の承認キューには「分からない」を置く場所がなく、時間に追われた人間は yes を押します。

### 限界(重要)

**盲検ではありません。** リクエストの `risk`(impact / exposure / uncertainty)と `reversibility` は、承認の判断が済んだ**後に**手で割り当てたものです。カーネルの結論はこの入力に依存するので、これは「カーネルが人間より正しかった」ことの独立した証明ではありません。

正直に言えるのはここまでです。

1. 承認規約を policy として機械可読に書き下せた
2. 同じ入力に対して決定論的に、理由付きの判定が出る
3. 人間が「危うい」と感じた箇所に、カーネルも独立した理由(証拠不足・不確実性超過)で引っかかった
4. `incomplete` が二値では表現できない状態を捕まえた

次に必要なのは、承認**前**に risk と reversibility をコマンドの静的解析から機械的に導出する層と、それを使った前向きの試験です。事後にラベルを付けた本実験は、その設計が意味を持つかの予備調査にすぎません。

## ライセンス

[Apache License 2.0](LICENSE) — Copyright 2026 CAPH TECH Inc.
