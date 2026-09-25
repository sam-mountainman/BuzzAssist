# 検査語彙（私的語の除去）— 作り方と、なぜ鍵つきか

`../SKILL.md` の「自動反映（sync）」の続き。sync が「語彙を照合できない」で止まったとき、検査語彙を
作り直すとき、共有台帳への capture が私的語で拒否されたときに読む。

## 何を照合するか

sync は overlay へ書く前に、Channel Pack 由来の語と、リポジトリ側にだけ置く検査語彙
（`sensitive-vocabulary.digest.json`、配布物には入れない）で私的語を除去する。一覧が壊れている・**無い**・
**鍵が無い**のどれでも同じく止まる。以前は「壊れていれば止まる、無ければ通る」で、語彙無しの overlay は
私的語の残存を検出できないのに、出力は「除去済み」と区別が付かなかった（欠落を許可として扱う型）。

## なぜ鍵つき（HMAC）か

以前の形式は公開した salt を使っていて、語彙を持たない第三者が短い名前を総当たりで戻せた
（ひらがな・カタカナ3文字までで 28 語中 4 語が 1.9 秒）。いまは鍵つきで、鍵はリポジトリの外にだけ置く——
環境変数 `BUZZASSIST_SENSITIVE_VOCABULARY_KEY` か、`~/.buzzassist/sensitive-vocabulary.key`。鍵を出力・
コミットしない。違う鍵で照合すると何にも当たらず「無検出」に見えるので、鍵の指紋が合わなければ止まる。

## 作り方

```bash
# 語彙を作る（平文一覧も鍵も git 追跡外、digest だけコミット）。初回は --new-key で鍵を作る
node scripts/audit-package-tarball.mjs build-vocabulary \
  --terms-file docs/learning/sensitive-vocabulary.local.txt \
  --include-channel-packs --new-key \
  --output docs/learning/sensitive-vocabulary.digest.json

# 開発用途に限り、語彙無しで生成する。overlay ヘッダに「語彙照合なし」が刻まれる
node scripts/harness-learn.mjs sync --allow-missing-vocabulary
```

`--allow-missing-vocabulary` で作った overlay は、ヘッダの印で読む側・監査側が見分けられる。CI・配布・
本番端末では使わず、印の付いた overlay をそのまま release へ載せない。自動の sync（Job の決着時・setup）には
この抜け道は無い。

## 共有台帳への capture

共有台帳（公開される）への `capture` も、同じ語彙に一致する語——人の名前、顧客の識別子、端末のパス——を
含めば拒否する。発言をそのまま引用せず、何を直すべきかの形に書き直す。鍵の無い端末では通るが、push 前の
検査が同じ語彙で止める。
