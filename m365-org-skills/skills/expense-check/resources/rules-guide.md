# rules.json の書き方

`resources/rules.json` を書き換えると、スクリプトを触らずに自社の経費規程に合わせられる。
書き換えたら JSON として正しいか (カンマ・引用符) を確認し、スキルの .zip を作り直して登録し直す。
利用者が別のルールファイルを添付した場合は `--rules <そのファイル>` で使える。

| キー | 意味 | 例 |
| --- | --- | --- |
| `columns` | 論理名 → 実際の列名。date / amount / category / payee / description / employee / receipt | `"amount": "金額(税込)"` |
| `column_aliases` | `columns` の列名が見つからないときに順に試す別名 | `"date": ["利用日", "支払日"]` |
| `required_columns` | 無ければファイル全体の指摘になる列 (論理名) | `["date", "amount"]` |
| `required_values` | 空欄なら行ごとにエラーにする列 (論理名) | `["date", "amount", "category"]` |
| `category_limits` | 費目ごとの 1 件あたり上限 (円)。費目名は全角/半角・空白の違いを無視して照合 | `"交際費": 20000` |
| `default_limit` | 上限表に無い費目に使う上限。使わないなら `null` | `100000` |
| `unknown_category` | 上限表に無い費目を `"warn"` (注意) / `"error"` / `"ignore"` | `"warn"` |
| `nonpositive_amount` | 金額 0 以下を `"warn"` / `"error"` / `"ignore"` | `"warn"` |
| `forbidden_keywords` | 含まれていたらエラーにする語 | `["商品券", "私用"]` |
| `keyword_columns` | 禁止語を探す列 (論理名) | `["description", "payee"]` |
| `max_age_days` | 利用日から何日を超えたら期限切れか。使わないなら `null` | `90` |
| `future_date` | 基準日より後の日付を `"error"` / `"warn"` / `"ignore"` | `"error"` |
| `reference_date` | 基準日を固定する (`"2026-10-01"`)。`null` なら実行した日 | `null` |
| `duplicate_keys` | この組み合わせが同じ行を「重複の疑い」にする (論理名) | `["date", "amount", "payee"]` |
| `duplicate` | 重複の疑いを `"warn"` / `"error"` / `"ignore"` (省略時 `"warn"`) | `"warn"` |
| `receipt_required_over` | この金額を超えるのに領収書列が空・「無」「なし」ならエラー。`null` で無効 | `30000` |
| `flag_weekends` | 土日の利用を注意にする | `false` |
| `flag_holidays` | `holidays` にある日の利用を注意にする | `false` |
| `holidays` | 祝日・会社休日の一覧 (YYYY-MM-DD)。同梱の一覧は例。自社カレンダーで必ず更新する | `["2026-01-01"]` |

`_` で始まるキー (`_説明` など) はメモ用で、スクリプトは読まない。
