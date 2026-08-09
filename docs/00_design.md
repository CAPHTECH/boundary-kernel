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

## 7. 契約

| ファイル | 役割 |
|---|---|
| `schemas/rbk.policy.v1.schema.json` | 境界の上限(ceiling)・閾値・権限地図 |
| `schemas/rbk.request.v1.schema.json` | 行為 + 証拠状態(計算の入力) |
| `schemas/rbk.decision.v3.schema.json` | routing(三値)+ measurement(`basis_complete`)+ factor 別の根拠 + 同一性 |
| `schemas/rbk.ledger_entry.v1.schema.json` | 追記専用台帳の1行(§8)。decision を記録する封筒であって、判定の契約ではない |

**契約は自分の主張を強制する。** `factors` の「6種を1回ずつ、必ず全て」は v0.2 では `description` に書いてあるだけで、重複も7件目も検証を通っていた。強制していない主張は契約ではないので、`minItems`/`maxItems` と factor 種別ごとの `contains`(`minContains`/`maxContains`)で表現し直した。`uniqueItems` は object 全体の比較なので、同じ factor 種別が別の verdict で2度現れる場合を弾けない — ここでは使えない。`validate.py` は、スキーマが拒否すべきインスタンス(重複・7件目・欠落)を実際に投げて拒否を確認する。

配列の**正準順**(factor enum 順など)はスキーマの妥当性条件にしていない。集合の順序は情報を持たないので、順序違いを無効にするのは誤りである。正準順は digest を取る際の規範であり、`normalize.ts` が担う。

`rbk.decision.v1` は撤回した。v1 は routing と measurement を単一の値に畳んでおり、§3 の訂正を表現できない。`basis_complete` を任意フィールドにすれば互換は保てたが、読み手が「無い = 完全」と解釈できてしまい、欠損を見えなくするという同じ失敗を再生産する。したがって必須フィールドとし、破壊的変更として v2 を切った。`rbk.policy.v1` / `rbk.request.v1` は変更していない。

### なぜ v3 を切ったか — 自分の規律を自分に適用する

`identity.policy_digest` を必須にした変更(§5)は、当初 `rbk.decision.v2` のまま入れようとしていた。v2 は既に `https://caph.tech/schemas/rbk.decision.v2.schema.json` で配信済みである。**公開済みの識別子のまま内容を破壊的に変えることは、「同じ `(id, version)` で内容が違う」状態そのものであり、本カーネルが policy について「検出できない危険な状態だ」と警告している当のものである。** 自分の契約に対してそれをやれば、v2 を取得済みの読み手は、自分の持つ定義が現在の定義と違うことを知る手段を持たない — ラベルは同じなのだから。

したがって `rbk.decision.v3` を切った。規律は policy に課しているものと同一である: **実質的な変更には新しい版を与え、既に配られた版はそのまま残す。** caph.tech 上の v2 は古い定義として正しいまま置き、このリポジトリは v3 のみを持つ(2つの定義を1つの識別子に重ねないため、v2 のファイルは復元しない)。`decision_schema` が `decision_id` の入力に入っているので、v2 の decision と v3 の decision は id の上でも別物である。

自分の製品原則が自分に適用されたときに面倒でも守れるか、が原則が本物かどうかの試験になる。ここではその記録として残す。

実装は言語非依存(Rust の reviewgraphen、TypeScript の Assay Kit / Cloudflare OS Gadget の双方から使う)。共有するのは**コードではなく契約と語彙**である。

## 8. Agency Ledger-lite — 判断の来歴(追記専用 JSONL)

`decide()` が出した判断を**追記専用の JSONL 台帳**として残す。1行 = 1判断。

**台帳は観測であって判定ではない。** カーネルの契約には一切触れない — `decision_id` の定義も、二軸の合成規則も、factor の意味も、台帳側では変えない。台帳がやるのは、decision を**そのまま封筒に入れて時刻を添えること**だけである。

### なぜ decision を丸ごと入れるのか(射影にしない)

台帳の行は `rbk.decision.v3` を**そのまま**埋め込む。「outcome と basis_complete と factor の verdict だけ抜き出す」射影にはしない。抜き出す判断を台帳側が持てば、契約が2箇所に分かれて必ず食い違うからである。要求されている記録項目 — `decision_id` / `outcome` / `basis_complete` / 6 factor の verdict と reasons / `evidence_state_digest` と policy の識別 / 基盤が欠けたときの「次に観測すべきこと」 — は、すべて decision schema が既に必須にしている。台帳がもう一度定義し直す理由はない。

**二軸は二軸のまま残る。** `outcome`(routing)と `basis_complete`(measurement)は decision の別々のフィールドとして記録され、集計でも別々に数える(下記)。片方をもう片方に畳む余地は、台帳のどこにも作らない。

### 封筒が足すもの

| フィールド | なぜ decision 側にないか |
|---|---|
| `recorded_at` | 台帳に書いた時刻。判断時刻(`decision.computed_at`)とは別の量で、差は台帳への反映遅れである |
| `requested_at`(任意) | 行為が要求された時刻。カーネルの入力に無い。ホストが知っているときだけ入る |
| `action`(識別) | decision は action を `action_digest` でしか持たない。digest は同一性のためで、可読性のためではない |
| `human_admission`(任意) | U(授権)を誰が握っていたかの事実。カーネルは判定に使わない |
| `ledger_id` / `seq` | 行の同一性と追記順。`decision_id` は同じ入力なら再計算で同じ値になるので、**行**を一意に指せない |

**判断時刻は重複させない。** `decision.computed_at` を封筒側にコピーすれば「同じことを言う2つのフィールドが食い違う」状態を自分で作ることになる。時刻は decision の中の1箇所にしか無い。

### 時刻を必ず持つ理由

製品文書の**限界2**: 三値化がスループットに与える影響を一度も測っていない。「厳格にすれば遅くなるのでは」という反論に現在答えを持っておらず、`incomplete` で滞留が伸びる可能性は未検証の仮説のままである。**後から測れる形で残しておかなければ、答えは永久に出ない。** 滞留時間 = `decision.computed_at − requested_at` はここからしか出せない。

`requested_at` を持たない行は、集計側で**未計測として別に数える**(`queue_latency.unmeasured`)。計測できた母集団に混ぜて平均を出せば、部分的な計測を完全な計測として提示することになる。

### 追記専用と訂正

追記専用性を**構造として**表現する。文書上の約束にはしない。

- `seq` は 0 以上で狭義単調増加する。行の書き換えは、連番の重複または巻き戻しとして現れる — 読み出し側(`readLedger()`)と `validate.py` がこれを拒否する。
- 訂正は**新しい行**で行う(`record_kind: 'correction'` + `supersedes`)。訂正される行はそのまま残る。理由(`supersedes.reason`)は必須である — 理由のない訂正は履歴を壊すだけで、「理由のない制限を出力しない」(§4)と同じ規律を適用する。
- **訂正できるのは封筒だけで、decision ではない。** 訂正行は元の行と同じ `decision_id` を持たなければならない。計算されたものは計算されたのであって、台帳がそれを書き直す権限は無い。
- 逆に、証拠が増えて判断し直したものは**訂正ではない**。それ自体が新しい判断であり、前の判断を無効にはしない(スキーマは `record_kind: 'decision'` が `supersedes` を持つことを禁じる)。2つの判断の関係は `attribute()` が扱う領域である。

ファイル I/O は台帳モジュールに入れない(`src/` は Workers でも動く依存ゼロを維持する)。追記はホスト側の1行である。

### 集計

読み出し側の最小集計(`summarize()`)。

- `by_outcome` — 三値を**別々に**数える。`incomplete` を `human_required` に足さない(§6)
- `basis_incomplete` — 基盤が欠けた行の数。routing に関わらず数えるので `by_outcome.incomplete` の**上位集合**である。`human_required` かつ基盤欠損の行がここに現れる — v0.1 が失っていた情報がそのまま集計に出る
- `basis_gap_by_factor` — どの factor が欠損を報告したか。6種すべてをキーとして持つので、0 は 0 として見える
- `required_evidence_modes` — 「次に何を観測すべきか」の内訳。**これは「あと少しで承認できる案件の待ち行列」ではない。** 欠けた観測が埋まった結果 `human_required` になることは普通に起きる(§3)。示しているのは達成可能性ではなく、計算不能を解消する手段である
- `queue_latency` — 滞留時間(全体および outcome 別)。計測できた件数と未計測の件数を必ず併記する

訂正された行は集計から除外し、訂正行のほうを数える(`superseded` / `corrections` として件数は報告する)。

### 下流

ct-biz 側の D4(判断と来歴)への自社適用がそのまま PoC の実データ検証になる。自社の授権判断を `caphtech-self` policy pack で計算し、その出力をこの台帳に積めば、**`incomplete` の件数と滞留時間が同時に取れる** — 「二値の承認キューには分からないの置き場がない」という主張と、「厳格にすれば遅くなるのでは」という反論が、同じ台帳の別の列として並ぶ。
