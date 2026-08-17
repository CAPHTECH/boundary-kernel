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

基盤の欠損は**行き先を示せなければ記録した意味がない**。`basis_complete == false` の decision は、outcome が `human_required` であっても `routing.required_evidence_modes` を必ず伴う。

⚠️ **この「行き先を示す」という設計意図は、v3 では達成されていない。**`required_evidence_modes` が実際に返すのは受理されうる mode の一覧であって、「次に何を観測すべきか」ではない。理由と、直さないと決めた経緯は §7 の「v3 の限界」。

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
                             policy_digest, policy_id, policy_version,
                             decision_schema, kernel_version)
```

`decision_id` は**入力だけでなく計算そのもの**を同定する。同じ入力でも、schema の版が違えば decision の意味が違う(v1 は routing と measurement を1つの値に畳んでいた。v2 は policy をラベルでしか縛っていなかった)し、カーネルの版が違えば同じ request から違う境界を引きうる。したがって `decision_schema`(`rbk.decision.v3`)と `kernel_version` も digest の入力である。含めなければ、構造も意味論も違う2つの decision が同じ id を持つ。

ここで束ねるのは**実際に計算したカーネルの版**(`KERNEL_VERSION`)であって、`decide()` のオプションでホストが差し替えられる表示用のラベルではない。後者を束ねると、同一の計算に対してホストが好きなだけ別の id を作れてしまう。

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
- **読めなかった入力を `satisfied` として扱わない**(v0.3 までの誤り。下記)

### 読めない入力は人間へ回す(v0.4 で訂正)

**v0.3.0 まで、`decide()` は入力を実行時に検証していなかった。**`Policy` と `Request` は TypeScript の型としてのみ受け取られており、型は検査ではない。順序比較は `indexOf` で書かれている:

```ts
const severityRank = (level: Severity): number => SEVERITY_ORDER.indexOf(level);  // enum 外は -1
if (severityRank(risk.impact) > severityRank(policy.risk.max_impact)) { ... }
```

`max_impact: "high"` に対して enum 外の `impact` は `-1 > 3` となり**偽**。verdict も理由も積まれず、factor は `satisfied` に解決し、decision は **`auto_apply` / `basis_complete: true` / `reasons: []`** に合成された。**大文字小文字の違いで足りた** — `"critical"` は `human_required`、`"CRITICAL"` は `auto_apply`。同型の箇所が8つあった(`action.risk.impact` / `action.applicability.status` / evidence item の `freshness.status` と `outcome` / `action.risk.exposure` / `action.risk.uncertainty` / `policy.reversibility.minimum` / `policy.evidence.minimum_assurance`)。`action.reversibility` は `switch` から落ちて `undefined` を返し、例外になっていた。

**倒れる向きが逆だった。**このカーネルは「人間を通さず適用してよいか」を決めるために存在する。読めなかった入力に対する正しい答えは**人間へ回すこと**であって、通すことではない。v0.4 は定義域外の値を、それを読む factor の次の状態に変える。

```
verdict:        human_required   routing —— 人間が見る必要がある
basis_complete: false            measurement —— 我々の基盤は欠けていた
reasons:        非空             フィールド・届いた値・期待される定義域を名指しする
```

**両軸を同時に立てるのは、両方が同時に真だからである** —— §3 で分けた独立性そのものである。

**`incomplete` にはしない。**`incomplete` の救済手段は追加観測であり(`evaluateRisk` が `max_uncertainty` にこれを使うのはそのためである)、enum 外の値はいくら観測し直しても直らない。`incomplete` へ回すと、ホストには「証拠を足して再提出せよ」と伝わる。`"CRITICAL"` を決定論的に吐くホストはそこで無限に回り続け、**直せる人間には永久に到達しない。**

**検証の定義域は `types.ts` の `readonly` 配列から導出する**(ここで書き直さない)。enum にメンバーを足したときに検証側だけが取り残されるのを防ぐためで、`types.ts` が既に「スキーマの enum が変わったときに変更する唯一の場所」を自認していることに依存している。

**欠陥は2種に分ける。**正規化も digest もできない**形状**の欠陥(`items` が配列でない等)は例外を投げる —— `identity.policy_digest` は decision の同一性の一部であり、それを計算できない以上、返せる `rbk.decision.v3` が存在しない。canonicalize はできるが値が定義域の外にある**定義域**の欠陥は、上記の `human_required` になる。

**公開スキーマは切り直していない。**enum はもともと `rbk.request.v1` / `rbk.policy.v1` に宣言されていた。v0.4 で通らなくなる入力は**元からスキーマ違反**であり、契約は動いていない。カーネルが自分の公開契約を執行していなかっただけである。破壊的なのはホストに対してであり(これまで `auto_apply` を受け取っていた入力が `human_required` を返す)、そのためカーネルの版を上げた。`KERNEL_VERSION` は `decision_id` の pre-image に入るので、**同じ request でも v0.3.0 とは異なる `decision_id` になる** —— §5 が「後のカーネルは同じ request から別の境界を引きうる」と書いた、まさにその状況である。

## 7. 契約

| ファイル | 役割 |
|---|---|
| `schemas/rbk.policy.v1.schema.json` | 境界の上限(ceiling)・閾値・権限地図 |
| `schemas/rbk.request.v1.schema.json` | 行為 + 証拠状態(計算の入力) |
| `schemas/rbk.decision.v3.schema.json` | routing(三値)+ measurement(`basis_complete`)+ factor 別の根拠 + 同一性 |

**契約は自分の主張を強制する。** `factors` の「6種を1回ずつ、必ず全て」は v0.2 では `description` に書いてあるだけで、重複も7件目も検証を通っていた。強制していない主張は契約ではないので、`minItems`/`maxItems` と factor 種別ごとの `contains`(`minContains`/`maxContains`)で表現し直した。`uniqueItems` は object 全体の比較なので、同じ factor 種別が別の verdict で2度現れる場合を弾けない — ここでは使えない。`validate.py` は、スキーマが拒否すべきインスタンス(重複・7件目・欠落)を実際に投げて拒否を確認する。

配列の**正準順**(factor enum 順など)はスキーマの妥当性条件にしていない。集合の順序は情報を持たないので、順序違いを無効にするのは誤りである。正準順は digest を取る際の規範であり、`normalize.ts` が担う。

`rbk.decision.v1` は撤回した。v1 は routing と measurement を単一の値に畳んでおり、§3 の訂正を表現できない。`basis_complete` を任意フィールドにすれば互換は保てたが、読み手が「無い = 完全」と解釈できてしまい、欠損を見えなくするという同じ失敗を再生産する。したがって必須フィールドとし、破壊的変更として v2 を切った。`rbk.policy.v1` / `rbk.request.v1` は変更していない。

### なぜ v3 を切ったか — 自分の規律を自分に適用する

`identity.policy_digest` を必須にした変更(§5)は、当初 `rbk.decision.v2` のまま入れようとしていた。v2 は既に `https://caph.tech/schemas/rbk.decision.v2.schema.json` で配信済みである。**公開済みの識別子のまま内容を破壊的に変えることは、「同じ `(id, version)` で内容が違う」状態そのものであり、本カーネルが policy について「検出できない危険な状態だ」と警告している当のものである。** 自分の契約に対してそれをやれば、v2 を取得済みの読み手は、自分の持つ定義が現在の定義と違うことを知る手段を持たない — ラベルは同じなのだから。

したがって `rbk.decision.v3` を切った。規律は policy に課しているものと同一である: **実質的な変更には新しい版を与え、既に配られた版はそのまま残す。** caph.tech 上の v2 は古い定義として正しいまま置き、このリポジトリは v3 のみを持つ(2つの定義を1つの識別子に重ねないため、v2 のファイルは復元しない)。`decision_schema` が `decision_id` の入力に入っているので、v2 の decision と v3 の decision は id の上でも別物である。

自分の製品原則が自分に適用されたときに面倒でも守れるか、が原則が本物かどうかの試験になる。ここではその記録として残す。

### v3 の限界 — `routing.required_evidence_modes` は「必要な mode」を表現できない(2026-08-15 確定。直さない)

**この欄は、スキーマの `description` が主張する意味を持てない。**`schemas/rbk.decision.v3.schema.json` はこれを「基盤の欠損を解消するために必要な証拠の種別」「『次に何を観測すべきか』を必ず返す」と定義している。**実装が返しているのは `accepted_modes` 全体であり、「必要な mode」ではない。**

まず起きたことを書く。この欄が accepted_modes を丸ごと再掲することは、読んだエージェントが2度誤読して発覚した。そこで「充足済みの mode を差し引いて残りだけを返す」修正を実装した(`decide()` を実際に呼んで実測)。**別系統モデルによる独立レビューがこれを3点で否定し、修正は取り下げた。**

1. **差し引き後の出力が「必要」の主張として偽になる。** policy は distinct mode の数ではなく **qualifying item の件数**を数える。`minimum_count` が gap のとき、**既に充足している mode にもう1件足せば gap は閉じる**。したがって差し引きで残った mode は「これを観測しなければ埋まらない」ものではない。差し引く前は「候補の列挙」として無害だった出力が、差し引くことで**偽の必要性を主張する出力**に変わる。
2. **evidence 以外が gap のとき、観測しても変わらない mode を名指しする。** 基盤の欠損を報告しうるのは `applicability` / `evidence` / `freshness` / `risk` / `reversibility` である(§4)。gap が `applicability`(capability_missing / unknown)・`risk`(未測定)・`reversibility`(unknown)に由来するとき、**どの evidence mode を観測しても gap は動かない**。それでも `basis_complete == false` は `minItems: 1` を課すので、欄を空にできない。**構造上、無関係な mode を必ず1つ以上名指しすることになる。**
3. **絞り込まれた出力のほうが誤読しやすい。** accepted_modes 全体の再掲は「候補一覧」に見えるが、絞り込まれた短いリストは「これをやれば閉じる」に見える。**修正は誤読を1つ消して、より強く誤読される出力を作った。**

**結論: この欄は v3 の枠内では意図した意味を持てない。**`minItems: 1` の制約と、件数で数える policy 意味論と、evidence 以外の gap の存在が同時に成り立つ限り、どう実装しても「必要な mode」にはならない。**したがって v3 は直さない。**

**読み手が取るべき扱い**: `routing.required_evidence_modes` を「**この decision で受理されうる evidence mode の一覧**」として読む。**「これを観測すれば基盤の欠損が埋まる」とは読まない。**何が欠けているかは `factors` の各 verdict と理由を見ること — 欠損の所在はそこにあり、この欄には無い。

**スキーマファイル自身の `description` は誤ったまま残してある。**`schemas/rbk.decision.v3.schema.json` は `https://caph.tech/schemas/rbk.decision.v3.schema.json` で配信済みで、ローカルの当該ファイルと公開物は SHA-256 が一致している(`3d39965e4b5d65dac0784a8b47fdbd394beb572c83dcc6ecc6b4c76fee59e907`)。**description だけでも書き換えれば「同じ `(id, version)` で内容が違う」状態を作る** — 直前の節で、自分がまさにそれを禁じたばかりである。訂正するなら v4 を切るのが筋であり、それは別の判断である(→ [RBK Concept の既知の穴](../../ct-biz/knowledge/products/boundary-kernel.md))。

実装は言語非依存(Rust の reviewgraphen、TypeScript の Assay Kit / Cloudflare OS Gadget の双方から使う)。共有するのは**コードではなく契約と語彙**である。
