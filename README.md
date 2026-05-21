# 山梨県・北杜市 1km人口密度メッシュマップ

国勢調査の1kmメッシュ人口・世帯数を使った、山梨県・北杜市のメッシュマップです。

## Build

```bash
npm run build
```

生成物:

- `output/mesh_map.html`: ローカル確認用の成果物
- `dist/index.html`: Cloudflare Pagesなどで配信する公開用HTML

## Cloudflare Pages

### Git連携で公開する場合

Cloudflare Pagesの設定:

- Framework preset: `None`
- Build command: `npm run build`
- Build output directory: `dist`

### Direct Uploadで試す場合

`npm run build` 後に、Cloudflare PagesのDirect Uploadで `dist/` ディレクトリをアップロードします。

## Notes

- 背景地図はOpenStreetMapタイルを利用しています。
- メッシュデータは `dist/index.html` に埋め込まれています。
- 北杜市判定は、2020年行政区域境界にメッシュ中心点が含まれるものを北杜市内として扱っています。
- 世帯数は国勢調査メッシュ統計の世帯総数を利用しています。
- 「別荘推定」はOpenStreetMapの建物データから明らかな非住宅系タグを除き、2020年世帯数を上回る候補建物が多い場所を近似的に可視化しています。住宅系タグの有無で信頼度補正をかけていますが、実際の別荘戸数ではありません。
