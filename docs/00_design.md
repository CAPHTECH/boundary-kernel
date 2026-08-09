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
- `incomplete` = 境界そのものが**計算できなかった**

⚠️ **`incomplete` は「解決すれば auto_apply だった」を意味しない。** 欠けていた観測が埋まった結果 `human_required` になることもある(例: `reversibility: unknown` が `irreversible` と判明する)。意味するのは達成可能性ではなく**計算不能**である。

`incomplete` は「計算基盤の欠損」を可視化する信号であり、これを人間レビューに混ぜると欠損が永久に見えなくなる。reviewgraphen の Gate 三値(`pass`/`blocked`/`incomplete`)、sdde の四状態における `unknown` と同じ規律である。

### 二軸に分ける — routing と measurement(v0.2 で訂正)

v0.1 の合成規則は次のとおりだった。

```
いずれかの factor が human_required  → human_required
それ以外で incomplete がある          → incomplete
すべて satisfied                     → auto_apply
```

**これは設計自身の原則を破っていた。** `human_required` と `incomplete` が同時に立ったとき、後者を捨てている。独立レビュー(別モデル系統)がこれを指摘し、実装で確認された([経緯](../../ct-biz/knowledge/products/rbk-critic-findings-2026-08-09.md))。

原因は**2つの異なる問いを1つの値に畳んだこと**である。

| 問い | 軸 | 値 |
|------|----|----|
| この行為をどこへ回すか | **routing** | `auto_apply` / `human_required` / `incomplete` |
| 我々の証拠基盤は十分だったか | **measurement** | `basis_complete: true / false` |

両者は同時に真になれる。「人間が決めるべきで、**かつ**我々の証拠基盤も欠けている」は普通に起きる状態であり、v0.1 はそれを表現できなかった。

**v0.2 の規則**:

```
routing:
  いずれかの factor が human_required  → human_required
  それ以外で incomplete がある          → incomplete
  すべて satisfied                     → auto_apply

measurement:
  いずれかの factor が incomplete を1つでも出した → basis_complete = false
```

`outcome == incomplete` は **`basis_complete == false` かつ `human_required` が無い**場合に一致する。つまり三値の `incomplete` は二軸の特殊ケースであり、**基盤の欠損は outcome に関わらず必ず記録される**。

factor 内でも同じ。1つの factor が `human_required` と `incomplete` の両方の理由を持つとき、verdict は `human_required` だが、**その factor が incomplete 信号を出したことを別に残す**(理由テキストに埋めない)。

基盤の欠損は**行き先を示せなければ記録した意味がない**。`basis_complete == false` の decision は、outcome が `human_required` であっても `routing.required_evidence_modes`(次に何を観測すべきか)を必ず伴う。

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

各 factor は独立に `satisfied` / `human_required` / `incomplete` を返し、**理由を必ず添える**。理由のない制限は出力しない。加えて各 factor は `basis_complete` を返す — その factor が incomplete 信号を出したかどうかであり、verdict が `human_required` になっても消えない(§3)。

`authority` と `reversibility` の `irreversible` / `compensatable` は policy の写像だけで決まるため、`basis_complete` は常に true になる。基盤の欠損を報告しうるのは `applicability`(capability_missing / unknown)、`evidence`(不足・inconclusive)、`freshness`(stale / unknown)、`risk`(未測定・不確実性超過)、`reversibility`(unknown)である。

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
policy_digest         = hash(policy の内容)
decision_id           = hash(action_digest, evidence_state_digest,
                             policy_digest, policy_id, policy_version)
```

policy を変えても `evidence_state_digest` は変わらない。これにより「同じ証拠に別の policy を当てる」比較が可能になり、**決定が変わった原因を機械的に切り分けられる**:

```
action_digest のみ変化                        → action change
evidence_state_digest のみ変化                → evidence change
policy_digest / policy_id / version のみ変化  → policy change
複数の軸が変化                                → 分離不能。その旨を宣言する(推測しない)
```

`policy_digest` / `policy_id` / `version` は同じ一つのもの(policy)の3成分であり、複数が同時に動いても原因は一つ、policy change である。

「分離できない比較を単一原因として提示しない」— sdde の規律をそのまま継承する。

### policy をラベルで縛っていた穴(v0.3 で塞いだ)

v0.2 の `decision_id` は policy を `policy_id` と `policy_version` — すなわち**ホストが付けるラベル**でしか縛っていなかった。その帰結:

> 同じ `(policy_id, version)` で内容の違う policy が、同じ `decision_id` を生む。outcome が変わっていても `attribute()` は `no_change` と報告する。

設計文書はこれを「塞げない穴」として記述し、理由をこう書いていた——「policy の content hash を入れても、ホストが同じ version のまま書き換える限り検出できない」。**この理由付けは誤りである。** content hash は version ラベルとは独立に、policy の内容が変わった時点で変わる。ラベルを据え置いたまま中身を書き換える行為こそ、content hash が検出するものである。誤った根拠で穴を残していた。

**塞いだ内容**:

- `identity.policy_digest` = 正規化後の policy の canonical JSON の SHA-256。decision schema で**必須**とする(任意にすると「無い = 縛っていない」が「無い = 問題ない」と読まれ、v1 の `basis_complete` と同じ失敗を再生産する)。
- `decision_id` の入力に `policy_digest` を含める。同じラベルで内容の違う policy は、別の `decision_id` を生む。
- `attribute()` は `policy_digest` の変化を `policy_change` として報告する。ラベル据え置きの書き換えはもう `no_change` にならない。
- カーネルは `policy_digest` を**引数として受け取らず、自分で計算する**。action / evidence の digest はホストが計算して渡す入力だが、policy の同一性はホストの規律に依存させない — させたら塞いだことにならない。

**塞いでいないもの(依然として真)**:

- `evidence_state_digest` は policy を含まない。これは穴ではなく設計であり、変えない。「同じ証拠に別の policy を当てる」比較が可能なのはこの分離のおかげである。`policy_digest` は decision の同一性側に置かれるので、両者は両立する。
- `(policy_id, version)` を不変に保つホスト側の規律は依然として有用である。ただしそれはもう**同一性の唯一の防壁ではない**。規律が破られたことは `policy_digest` が機械的に示す。

`test/identity.test.ts` はこの穴が塞がっていることを確認する — かつては穴の形を固定するテストが同じ場所にあった。

### 正規化(canonicalization)— v0.2 で追加

digest は言語非依存の契約である。同じ意味の入力が実装ごとに違うハッシュになってはならない。規範は二層に分ける。

**第1層: 意味の正規化(`normalize.ts`)。** digest を取る前に適用する。

1. **集合として宣言された配列は、正準順に並べ替える。** v0.1 はすべての配列を順序付きとして扱っていたため、`evidence_state.items` を並べ替えただけで `evidence_state_digest` が変わり、`attribute()` が `evidence_change` と誤報告した。
2. **文字列は NFC に正規化する。** `"café"` の NFC と NFD は読み手には同一で、SHA-256 には別物である。どちらを出すかはホストの言語処理系に依存するため、契約側で固定する。

**第2層: 直列化(`canonical.ts`)。** キーを昇順に並べ、余分な空白を置かず、`undefined` を落とす。**ここでは並べ替えも Unicode 正規化も行わない** — 直列化器にとって配列はすべて順序付きであり、入力を書き換える直列化器は入力の忠実な写像でなくなる(RFC 8785 が Unicode 正規化をアプリケーション側に委ねているのと同じ理由)。「その配列が集合かどうか」は意味の問題であって、書き方の問題ではない。

#### どの配列が集合で、どれが順序付きか

**集合**(順序に意味は無い。正準順は下記):

| 配列 | 正準順 |
|---|---|
| `action.requested_dimensions` | GAE ベクトル順 ⟨O,F,P,J,U,E,L⟩ |
| `evidence_state.items` | `evidence_id` 昇順(UTF-16 コード単位) |
| `evidence.freshness.reasons` | staleness 12分類の宣言順 |
| `policy.scope.action_kinds` / `domains` | コード単位昇順 |
| `policy.authority.non_human_may_hold` / `human_reserved` | GAE ベクトル順 |
| `policy.evidence.accepted_modes` | コード単位昇順 |
| `policy.freshness.tolerated_staleness_reasons` | staleness 12分類の宣言順 |
| `decision.granted_dimensions` / `withheld_dimensions` | GAE ベクトル順 |
| `decision.factors` | factor enum 順(6種を必ず全て含む) |
| `factor.evidence_ids` | `evidence_id` 昇順 |
| `routing.required_evidence_modes` | コード単位昇順 |
| `attribution.changed_components` | enum 宣言順 |

**順序付き**(順序それ自体がデータ):

| 配列 | 意味 |
|---|---|
| `action.applicability.reasons` | ホストが述べた理由の叙述順 |
| `factor.reasons` | カーネルが検出した順。並べ替えは根拠の提示順を変える |

policy も `policy_digest` を通じて digest の入力である(v0.3)。集合として扱う配列は同じ規律に従い、`normalizePolicy()` が実際に適用する — 順序違いは同じ policy であり、同じ `policy_digest` を生む。逆に `description` や `authorize_delegation_rationale` の文面は policy の内容であって、変えれば digest は動く。

`decide()` 自身も正規化後の request を見る。したがって集合の順序だけが違う2つの request は、digest が一致するだけでなく **decision がフィールド単位で一致する**。

## 6. 出力に対する禁止事項

- `incomplete` を `human_required` として集計しない
- **`human_required` が立ったことを理由に `basis_complete` を true に丸めない**(v0.1 の誤り)
- 満たされなかった factor を出力から省略しない(欠損は欠損として残す)
- 確率・スコアを「証明」と表示しない(測候方法論 §3.4 保証境界: `evaluator_supported` を `proved` と表示してはならない)
- policy 変更を evidence 変更として帰属しない

## 7. 契約

| ファイル | 役割 |
|---|---|
| `schemas/rbk.policy.v1.schema.json` | 境界の上限(ceiling)・閾値・権限地図 |
| `schemas/rbk.request.v1.schema.json` | 行為 + 証拠状態(計算の入力) |
| `schemas/rbk.decision.v2.schema.json` | routing(三値)+ measurement(`basis_complete`)+ factor 別の根拠 + 同一性 |

`rbk.decision.v1` は撤回した。v1 は routing と measurement を単一の値に畳んでおり、§3 の訂正を表現できない。`basis_complete` を任意フィールドにすれば互換は保てたが、読み手が「無い = 完全」と解釈できてしまい、欠損を見えなくするという同じ失敗を再生産する。したがって必須フィールドとし、破壊的変更として v2 を切った。`rbk.policy.v1` / `rbk.request.v1` は変更していない。

実装は言語非依存(Rust の reviewgraphen、TypeScript の Assay Kit / Cloudflare OS Gadget の双方から使う)。共有するのは**コードではなく契約と語彙**である。
