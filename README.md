# 山梨県・北杜市 1km人口密度メッシュマップ

国勢調査の1kmメッシュ人口を使った、山梨県・北杜市の人口密度メッシュマップです。

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
