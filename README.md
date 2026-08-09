# Review Boundary Kernel (RBK)

AI が提案した行為について、**一つの問いだけ**を扱う契約層です。

> **この行為を、人間を通さずに適用してよいか。**

答えは三値で、決定論的に計算されます。同じ入力なら常に同じ答えが出て、なぜそう判定したかの理由が必ず添えられます。

> **ステータス: 実験的 (v0.1.0)。** スキーマは v1 と名前が付いていますが、まだ固定していません。本番運用を前提にした保証はありません。

## 三値

```
auto_apply       機械が適用してよい
human_required   人間の判断が要る(理由が確定している)
incomplete       判断できない(境界の計算に必要なものが欠けている)
```

`incomplete` を `human_required` に潰さないことが設計の核です。両者は運用上の意味が違います。

- `human_required` = 制度上・リスク上、人間が決めるべきだと**分かっている**
- `incomplete` = 本来なら自動適用できたかもしれないが、**それを示せない**

合成規則は単調に狭まります。いずれかの factor が `human_required` なら `human_required`、それ以外で `incomplete` があれば `incomplete`、すべて満たされて初めて `auto_apply`。確定した制限が不確実性に優先するので、**`incomplete` は「自動適用したかったができなかった」場合にしか現れません**。ノイズではなく、計算基盤の欠損を指す信号だけが残ります。

判定は6つの factor に分解されます: `applicability` / `authority` / `evidence` / `freshness` / `risk` / `reversibility`。各 factor は独立に三値を返し、`satisfied` 以外には必ず理由が付きます。満たされなかった factor を出力から省くことはしません。

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
# TypeScript 参照実装 (tsc --noEmit + node:test, 96 テスト)
npm install
npm test

# スキーマと fixtures の整合性検査 (35 チェック)
pip install jsonschema
python3 validate.py

# 実地テストの再実行
node --experimental-strip-types experiments/herdr-approvals/run.ts
```

## 中身

| ディレクトリ | 内容 |
|---|---|
| `docs/00_design.md` | 設計正本。三値の非対称性、factor の由来、同一性と帰属の規律。 |
| `schemas/` | 契約そのもの。`rbk.policy.v1` / `rbk.request.v1` / `rbk.decision.v1`(JSON Schema Draft 2020-12)。 |
| `fixtures/` | 4シナリオ。`auto_apply` / 権限の留保 / 証拠の陳腐化による `incomplete` / リスク超過による `human_required`。各 `policy.json` + `request.json` + `expected-decision.json`。 |
| `src/` | TypeScript 参照実装。ランタイム依存ゼロ。`decide()` は**同期の純関数**で、digest は引数で受け取るため crypto に依存しません。 |
| `test/` | fixtures との一致、合成規則の網羅(3⁶ 全組み合わせ)、digest の決定論性、変化の帰属。 |
| `experiments/herdr-approvals/` | 実地テスト(下記)。 |

`validate.py` はスキーマだけでは強制できない不変条件も検査します — factor が6種揃っているか、非 `satisfied` に理由があるか、合成規則が守られているか、`auto_apply` なら留保次元が空か、など。

## 実地テスト: 6件中4件で一致

2026-08-09 のセッションで、オーケストレータがワーカーエージェントからのシェルコマンド要求を人間の目で承認/拒否した記録を、RBK で再現できるか試しました([`experiments/herdr-approvals/`](experiments/herdr-approvals/))。

| ケース | 人間の判断 | カーネル | |
|---|---|---|---|
| `grep`(read-only) | auto_apply | auto_apply | ✔ |
| `git checkout -b` | auto_apply | auto_apply | ✔ |
| **`npm install`** | **auto_apply** | **human_required** | ✘ |
| `git commit` | auto_apply | auto_apply | ✔ |
| `git push` | human_required | human_required | ✔ |
| **ヒアドキュメント(静的解析不能)** | **auto_apply** | **incomplete** | ✘ |

**不一致の2件は、どちらも人間の判断のほうが弱かった**ケースです。`npm install` は外部レジストリから未検査のコードを取得する操作を「ビルド確認に必要だから」で通していました。ヒアドキュメントの件は、人間が承認しつつメモに自分で「ここが最も危うい判断だった」と書いていた箇所です。カーネルはそこで `human_required` ではなく `incomplete` を返し、「解決に必要な観測: static_command_analysis, sandbox_scope_check」を示しました。二値の承認キューには「分からない」を置く場所がなく、時間に追われた人間は yes を押します。

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
